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
});
