import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InMemoryV2InputRegistry, JsonlV2InputRegistry } from "../src/inputs.ts";

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

	test("waits for a response and resolves waiters exactly once", async () => {
		const registry = new InMemoryV2InputRegistry();
		const request = await registry.create("session-1", [{ id: "name", prompt: "Your name?" }]);
		const waiting = registry.wait(request.id);
		await registry.respond(request.id, { name: "Ada" });
		expect(await waiting).toMatchObject({ status: "responded", answers: { name: "Ada" } });
		expect(await registry.wait(request.id)).toMatchObject({ status: "responded" });
	});
});

describe("JsonlV2InputRegistry", () => {
	test("rejects malformed persisted request records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-input-registry-invalid-"));
		const path = join(directory, "inputs.jsonl");
		await writeFile(path, `${JSON.stringify({ id: "request-1", sessionId: "session-1", status: "pending" })}\n`);
		const registry = new JsonlV2InputRegistry(path);
		await expect(registry.read("request-1")).rejects.toThrow("Input record questions are required");
	});

	test("restores pending and terminal requests after reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-input-registry-"));
		const path = join(directory, "inputs.jsonl");
		const first = new JsonlV2InputRegistry(path);
		const pending = await first.create("session-1", [{ id: "confirm", prompt: "Continue?" }]);
		const answered = await first.create("session-1", [{ id: "mode", prompt: "Mode?", options: [{ label: "Safe" }] }]);
		await first.respond(answered.id, { mode: "Safe" });

		const second = new JsonlV2InputRegistry(path);
		expect(await second.read(pending.id)).toMatchObject({ sessionId: "session-1", status: "pending" });
		expect(await second.pendingForSession("session-1")).toBe(pending.id);
		expect(await second.read(answered.id)).toMatchObject({ status: "responded", answers: { mode: "Safe" } });
	});
});
