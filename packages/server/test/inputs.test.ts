import { describe, expect, test } from "vitest";
import { InMemoryV2InputRegistry, MAX_V2_INPUT_TEXT_LENGTH, MAX_V2_INPUT_TIMER_MS } from "../src/inputs.ts";

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
		expect(await registry.pendingForSession("session-1")).toBeUndefined();
	});

	test("rejects unknown answer keys before storing a response", async () => {
		const registry = new InMemoryV2InputRegistry();
		const request = await registry.create("session-1", [{ id: "mode", prompt: "Choose mode" }]);

		await expect(registry.respond(request.id, { mode: "Fast", extra: "unexpected" })).rejects.toThrow(
			"unknown question",
		);
		expect((await registry.read(request.id)).status).toBe("pending");
	});

	test("accepts freeform answers when enabled alongside options", async () => {
		const registry = new InMemoryV2InputRegistry();
		const request = await registry.create("session-1", [
			{ id: "mode", prompt: "Choose mode", options: [{ label: "Fast" }], allowFreeform: true },
		]);

		await expect(registry.respond(request.id, { mode: "Custom mode" })).resolves.toMatchObject({
			status: "responded",
			answers: { mode: "Custom mode" },
		});
	});

	test("rejects invalid option answers and empty or oversized freeform answers", async () => {
		const registry = new InMemoryV2InputRegistry();
		const optionRequest = await registry.create("session-1", [
			{ id: "mode", prompt: "Choose mode", options: [{ label: "Fast" }] },
		]);
		await expect(registry.respond(optionRequest.id, { mode: "Custom mode" })).rejects.toThrow(
			"not one of the offered options",
		);

		const freeformRequest = await registry.create("session-1", [{ id: "note", prompt: "Add a note" }]);
		await expect(registry.respond(freeformRequest.id, { note: "   " })).rejects.toThrow("must not be empty");
		await expect(registry.respond(freeformRequest.id, { note: "x".repeat(MAX_V2_INPUT_TEXT_LENGTH + 1) })).rejects.toThrow(
			"too long",
		);
	});

	test("rejects empty option labels", async () => {
		const registry = new InMemoryV2InputRegistry();
		await expect(
			registry.create("session-1", [{ id: "mode", prompt: "Choose mode", options: [{ label: "  " }] }]),
		).rejects.toThrow("option label must not be empty");
	});

	test("rejects timer values that Node cannot schedule accurately", async () => {
		const registry = new InMemoryV2InputRegistry();
		await expect(
			registry.create("session-1", [{ id: "confirm", prompt: "Continue?" }], MAX_V2_INPUT_TIMER_MS + 1),
		).rejects.toThrow("autoResolutionMs must be between zero");
	});

	test("evicts the oldest terminal request at the configured capacity", async () => {
		const registry = new InMemoryV2InputRegistry({ maxRequests: 2 });
		const first = await registry.create("session-1", [{ id: "first", prompt: "First" }]);
		await registry.respond(first.id, { first: "done" });
		const second = await registry.create("session-1", [{ id: "second", prompt: "Second" }]);
		await registry.respond(second.id, { second: "done" });
		const third = await registry.create("session-1", [{ id: "third", prompt: "Third" }]);

		await expect(registry.read(first.id)).rejects.toThrow("Unknown input request");
		expect((await registry.read(second.id)).status).toBe("responded");
		expect((await registry.read(third.id)).status).toBe("pending");
	});

	test("indexes pending requests by session without losing the next request", async () => {
		const registry = new InMemoryV2InputRegistry();
		const first = await registry.create("session-1", [{ id: "first", prompt: "First" }]);
		const second = await registry.create("session-1", [{ id: "second", prompt: "Second" }]);

		expect(await registry.pendingForSession("session-1")).toBe(first.id);
		await registry.respond(first.id, { first: "done" });
		expect(await registry.pendingForSession("session-1")).toBe(second.id);
	});

	test("waits for a response and resolves waiters exactly once", async () => {
		const registry = new InMemoryV2InputRegistry();
		const request = await registry.create("session-1", [{ id: "name", prompt: "Your name?" }]);
		const waiting = registry.wait(request.id);
		await registry.respond(request.id, { name: "Ada" });
		expect(await waiting).toMatchObject({ status: "responded", answers: { name: "Ada" } });
		expect(await registry.wait(request.id)).toMatchObject({ status: "responded" });
	});
});
