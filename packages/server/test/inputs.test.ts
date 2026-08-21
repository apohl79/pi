import { describe, expect, test } from "vitest";
import { InMemoryV2InputRegistry } from "../src/inputs.ts";

describe("InMemoryV2InputRegistry", () => {
	test("validates structured questions and accepts one response", async () => {
		const registry = new InMemoryV2InputRegistry();
		const request = await registry.create("session-1", [
			{ id: "mode", prompt: "Choose mode", options: [{ label: "Fast" }, { label: "Safe" }] },
		]);
		expect(request).toMatchObject({ sessionId: "session-1", status: "pending", questions: [{ id: "mode" }] });
		const answered = await registry.respond(request.id, { mode: "Fast" });
		expect(answered).toMatchObject({ id: request.id, status: "responded", answers: { mode: "Fast" } });
		await expect(registry.respond(request.id, { mode: "Safe" })).rejects.toThrow("not pending");
	});

	test("auto-resolves a pending request on the server deadline", async () => {
		const registry = new InMemoryV2InputRegistry();
		const request = await registry.create("session-1", [{ id: "confirm", prompt: "Continue?" }], 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await registry.read(request.id)).toMatchObject({ status: "expired", answers: {} });
	});
});
