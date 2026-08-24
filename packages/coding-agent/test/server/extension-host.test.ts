import { describe, expect, it } from "vitest";
import { type ServerRuntimeExtension, ServerRuntimeExtensionHost } from "../../src/server/extension-host.ts";

describe("ServerRuntimeExtensionHost", () => {
	it("runs server-owned hooks with resolved model access and durable state", async () => {
		const persisted: Array<{ extensionId: string; key: string; value: unknown }> = [];
		const calls: string[] = [];
		const extension: ServerRuntimeExtension = {
			id: "audit",
			capabilities: ["diagnostics", "state"],
			async onOperationAccepted(context) {
				calls.push(`${context.operation.type}:${context.model.id}:${context.capabilities.join(",")}`);
				await context.state.set("lastOperation", context.operation.id);
			},
			onOperationTerminal(context) {
				calls.push(`terminal:${context.operation.id}`);
			},
		};
		const host = new ServerRuntimeExtensionHost({
			resolveModel: () => ({ id: "model-a", provider: "test" }),
			loadState: (extensionId, key) =>
				persisted.find((entry) => entry.extensionId === extensionId && entry.key === key)?.value,
			persistState: async (extensionId, key, value) => {
				persisted.push({ extensionId, key, value });
			},
		});

		await host.register(extension);
		await host.onOperationAccepted({ id: "op-1", type: "turn/start" });
		host.onOperationTerminal({ id: "op-1", type: "turn/start" }, "ok");

		expect(calls).toEqual(["turn/start:model-a:diagnostics,state", "terminal:op-1"]);
		expect(persisted).toEqual([{ extensionId: "audit", key: "lastOperation", value: "op-1" }]);
		expect(await host.getState("audit", "lastOperation")).toBe("op-1");
	});

	it("rejects duplicate ids and isolates client-owned registrations", async () => {
		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "model-a" }) });
		const extension: ServerRuntimeExtension = { id: "same" };
		await host.register(extension);

		await expect(host.register(extension)).rejects.toThrow("already registered");
		await expect(host.register({ id: "ui", scope: "client" })).rejects.toThrow(
			"client-only extensions cannot register with the server host",
		);
		expect(() => host.registerClientCommand("client-command")).toThrow(
			"server runtime extensions cannot register client commands",
		);
	});

	it("uses the operation's frozen model when supplied", async () => {
		const models: string[] = [];
		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "current-model" }) });
		await host.register({
			id: "frozen-model",
			onOperationAccepted: ({ model }) => {
				models.push(`accepted:${model.id}`);
			},
			onOperationTerminal: ({ model }) => {
				models.push(`terminal:${model.id}`);
			},
		});
		await host.onOperationAccepted({ id: "op-1", type: "turn/start", model: { id: "accepted-model" } });
		await host.onOperationTerminal({ id: "op-1", type: "turn/start", model: { id: "accepted-model" } }, "completed");
		expect(models).toEqual(["accepted:accepted-model", "terminal:accepted-model"]);
	});

	it("isolates hook failures and returns per-extension outcomes", async () => {
		const calls: string[] = [];
		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "model-a" }) });
		await host.register({
			id: "fails",
			onOperationAccepted: async () => {
				calls.push("fails");
				throw new Error("extension failed");
			},
		});
		await host.register({
			id: "survives",
			onOperationAccepted: () => {
				calls.push("survives");
			},
		});

		const results = await host.onOperationAccepted({ id: "op-1", type: "turn/start" });

		expect(calls).toEqual(["fails", "survives"]);
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ extensionId: "fails", status: "rejected" });
		expect(results[1]).toEqual({ extensionId: "survives", status: "fulfilled" });
	});

	it("collects bounded request-only sampling input in registration order", async () => {
		const host = new ServerRuntimeExtensionHost({
			resolveModel: () => ({ id: "model-a" }),
			maxSamplingMessages: 2,
			maxSamplingCharacters: 10_000,
		});
		await host.register({
			id: "first",
			contributeSamplingInput: () => [{ role: "user", content: "first", timestamp: 0 }],
		});
		await host.register({
			id: "second",
			contributeSamplingInput: () => [
				{ role: "user", content: "second", timestamp: 0 },
				{ role: "user", content: "ignored", timestamp: 0 },
			],
		});

		const result = await host.collectSamplingInput({ model: {} as never, systemPrompt: "", messages: [], tools: [] });

		expect(result.messages).toEqual([
			{ role: "user", content: "first", timestamp: 0 },
			{ role: "user", content: "second", timestamp: 0 },
		]);
		expect(result.outcomes).toEqual([
			{ extensionId: "first", status: "fulfilled" },
			{ extensionId: "second", status: "fulfilled" },
		]);
	});

	it("isolates sampling contributor failures", async () => {
		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "model-a" }) });
		await host.register({ id: "fails", contributeSamplingInput: () => Promise.reject(new Error("sampling failed")) });
		await host.register({
			id: "survives",
			contributeSamplingInput: () => [{ role: "user", content: "kept", timestamp: 0 }],
		});

		const result = await host.collectSamplingInput({ model: {} as never, systemPrompt: "", messages: [], tools: [] });

		expect(result.messages).toEqual([{ role: "user", content: "kept", timestamp: 0 }]);
		expect(result.outcomes[0]).toMatchObject({ extensionId: "fails", status: "rejected" });
		expect(result.outcomes[1]).toEqual({ extensionId: "survives", status: "fulfilled" });
	});

	it("dispatches declared runtime events without sharing mutable payloads", async () => {
		const received: string[] = [];
		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "model-a" }) });
		await host.register({
			id: "items-only",
			events: ["item_completed"],
			onRuntimeEvent: (event) => {
				received.push(`${event.event}:${String(event.payload.role)}`);
				event.payload.role = "mutated";
			},
		});
		await host.register({
			id: "all-events",
			onRuntimeEvent: (event) => {
				received.push(event.event);
			},
		});

		const event = { sessionId: "s1", event: "item_completed" as const, payload: { role: "assistant" } };
		const outcomes = await host.dispatchRuntimeEvent(event);

		expect(received).toEqual(["item_completed:assistant", "item_completed"]);
		expect(event.payload.role).toBe("assistant");
		expect(outcomes).toEqual([
			{ extensionId: "items-only", status: "fulfilled" },
			{ extensionId: "all-events", status: "fulfilled" },
		]);
	});
});
