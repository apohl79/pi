import { describe, expect, it } from "vitest";
import { type ServerRuntimeExtension, ServerRuntimeExtensionHost } from "../../src/server/extension-host.ts";

describe("ServerRuntimeExtensionHost", () => {
	it("runs server-owned hooks with resolved model access and durable state", async () => {
		const persisted: Array<{ extensionId: string; key: string; value: unknown }> = [];
		const calls: string[] = [];
		const extension: ServerRuntimeExtension = {
			id: "audit",
			async onOperationAccepted(context) {
				calls.push(`${context.operation.type}:${context.model.id}`);
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

		expect(calls).toEqual(["turn/start:model-a", "terminal:op-1"]);
		expect(persisted).toEqual([{ extensionId: "audit", key: "lastOperation", value: "op-1" }]);
		expect(await host.getState("audit", "lastOperation")).toBe("op-1");
	});

	it("rejects duplicate ids and isolates client-owned registrations", async () => {
		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "model-a" }) });
		const extension: ServerRuntimeExtension = { id: "same" };
		await host.register(extension);

		await expect(host.register(extension)).rejects.toThrow("already registered");
		expect(() => host.registerClientCommand("client-command")).toThrow(
			"server runtime extensions cannot register client commands",
		);
	});
});
