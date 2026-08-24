import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InMemoryV2PlanRegistry, JsonlV2PlanRegistry } from "../src/plans.ts";

describe("InMemoryV2PlanRegistry", () => {
	test("versions valid plans and rejects multiple in-progress steps", async () => {
		const registry = new InMemoryV2PlanRegistry();
		const first = await registry.update("session-1", {
			items: [
				{ step: "inspect", status: "completed" },
				{ step: "implement", status: "in_progress" },
			],
		});
		expect(first).toEqual({
			version: 1,
			items: [
				{ step: "inspect", status: "completed" },
				{ step: "implement", status: "in_progress" },
			],
		});
		expect(await registry.read("session-1")).toEqual(first);
		await expect(
			registry.update("session-1", {
				items: [
					{ step: "a", status: "in_progress" },
					{ step: "b", status: "in_progress" },
				],
			}),
		).rejects.toThrow("one in-progress");
	});

	test("recovers the latest plan after reopening its JSONL store", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-v2-plans-"));
		try {
			const path = join(directory, "plans.jsonl");
			const first = new JsonlV2PlanRegistry(path);
			await first.update("session-1", { items: [{ step: "persist", status: "in_progress" }] });
			await first.update("session-1", {
				version: 2,
				items: [{ step: "persist", status: "completed" }],
			});
			const reopened = new JsonlV2PlanRegistry(path);
			expect(await reopened.read("session-1")).toEqual({
				version: 2,
				items: [{ step: "persist", status: "completed" }],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("persists an explicit clear marker", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-v2-plans-clear-"));
		try {
			const path = join(directory, "plans.jsonl");
			const first = new JsonlV2PlanRegistry(path);
			await first.update("session-1", { items: [{ step: "clear", status: "pending" }] });
			await first.clear("session-1");
			const reopened = new JsonlV2PlanRegistry(path);
			expect(await reopened.read("session-1")).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects malformed persisted plan records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-v2-plans-invalid-"));
		try {
			const path = join(directory, "plans.jsonl");
			await writeFile(path, `${JSON.stringify({ sessionId: "session-1", plan: { version: 0, items: [] } })}\n`);
			const registry = new JsonlV2PlanRegistry(path);
			await expect(registry.read("session-1")).rejects.toThrow("Invalid plan record snapshot");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
