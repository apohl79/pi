import { describe, expect, test } from "vitest";
import { type AgentSummary, InMemoryV2AgentRegistry } from "../src/agents.ts";

describe("InMemoryV2AgentRegistry", () => {
	test("maintains stable child paths and explicit lifecycle transitions", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxDepth: 1, maxActive: 2 });
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "research",
			taskMessage: "inspect auth",
			model: { provider: "test", id: "small" },
		});

		expect(child).toMatchObject({ path: "/root/research", state: "running", taskName: "research" });
		expect(await registry.list("session-1")).toEqual([child]);
		await registry.interrupt(child.id);
		expect(await registry.wait(child.id)).toMatchObject({ id: child.id, state: "interrupted" });
		await expect(
			registry.spawn({
				sessionId: "session-1",
				parentPath: child.path,
				taskName: "nested",
				taskMessage: "too deep",
				model: child.model,
			}),
		).rejects.toThrow("maximum depth");
	});

	test("queues messages without starting idle children and follow-up starts them", async () => {
		const registry = new InMemoryV2AgentRegistry();
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "tests",
			taskMessage: "run tests",
			model: { provider: "test", id: "small" },
		});
		await registry.complete(child.id);
		await registry.message(child.id, "review output");
		expect(await registry.wait(child.id)).toMatchObject({ state: "complete" });
		await registry.followUp(child.id, "fix failures");
		expect(await registry.list("session-1")).toContainEqual(
			expect.objectContaining({ id: child.id, state: "running" }),
		);
	});

	test("waits for completion, preserves role, and scopes paths to a session", async () => {
		const registry = new InMemoryV2AgentRegistry();
		const first = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "same",
			taskMessage: "start",
			role: "worker",
			model: { provider: "test", id: "small" },
		});
		const pending = registry.wait(first.id, 20);
		await Promise.resolve();
		await registry.complete(first.id);
		expect(await pending).toMatchObject({ state: "complete", role: "worker" });
		const other = await registry.spawn({
			sessionId: "session-2",
			parentPath: "/root",
			taskName: "same",
			taskMessage: "start",
			model: { provider: "test", id: "small" },
		});
		expect(other.path).toBe(first.path);
	});

	test("bounds message retention and permits follow-up from awaiting input", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxMessages: 2, maxMessageLength: 4 });
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "input",
			taskMessage: "init",
			model: { provider: "test", id: "small" },
		});
		await registry.message(child.id, "more");
		await expect(registry.message(child.id, "too long")).rejects.toThrow("maximum length");
		const internal = registry as unknown as { agents: Map<string, { state: AgentSummary["state"] }> };
		internal.agents.get(child.id)!.state = "awaitingInput";
		expect(await registry.followUp(child.id, "next")).toMatchObject({ state: "running" });
	});

	test("enforces the active limit when follow-up resumes an agent", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxActive: 1 });
		const first = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "first",
			taskMessage: "start",
			model: { provider: "test", id: "small" },
		});
		await registry.complete(first.id);
		const second = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "second",
			taskMessage: "start",
			model: { provider: "test", id: "small" },
		});

		await expect(registry.followUp(first.id, "resume")).rejects.toThrow("active limit");
		expect(await registry.wait(first.id)).toMatchObject({ state: "complete" });
		expect(await registry.list("session-1")).toContainEqual(
			expect.objectContaining({ id: second.id, state: "running" }),
		);
	});

	test.each([
		["maxDepth", -1],
		["maxDepth", Number.NaN],
		["maxActive", -1],
		["maxActive", Number.POSITIVE_INFINITY],
		["maxMessages", 0],
		["maxMessages", 1.5],
		["maxMessageLength", 0],
		["maxMessageLength", Number.NaN],
	] as const)("rejects invalid %s limit (%s)", (name, value) => {
		expect(() => new InMemoryV2AgentRegistry({ [name]: value })).toThrow(name);
	});
});
