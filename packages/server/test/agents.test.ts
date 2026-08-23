import { describe, expect, test } from "vitest";
import { type AgentSummary, type V2AgentRegistry, InMemoryV2AgentRegistry } from "../src/agents.ts";

describe("InMemoryV2AgentRegistry", () => {
	test("maintains stable child paths and explicit lifecycle transitions", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxDepth: 1, maxActive: 2 });
		const typedRegistry: V2AgentRegistry = registry;
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "research",
			taskMessage: "inspect auth",
			model: { provider: "test", id: "small" },
		});

		expect(child).toMatchObject({
			path: "/root/research",
			state: "running",
			taskName: "research",
			startedAt: expect.any(Number),
		});
		expect(await registry.list("session-1")).toEqual([child]);
		await typedRegistry.interrupt(child.id);
		await typedRegistry.complete(child.id);
		expect(await typedRegistry.wait(child.id)).toMatchObject({ id: child.id, state: "complete" });
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

	test("rejects direct messages to terminal children while follow-up starts them", async () => {
		const registry = new InMemoryV2AgentRegistry();
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "tests",
			taskMessage: "run tests",
			model: { provider: "test", id: "small" },
		});
		await registry.complete(child.id);
		await expect(registry.message(child.id, "review output")).rejects.toThrow("terminal agent");
		expect(await registry.wait(child.id)).toMatchObject({ state: "complete" });
		await registry.followUp(child.id, "fix failures");
		expect(await registry.list("session-1")).toContainEqual(
			expect.objectContaining({ id: child.id, state: "running" }),
		);
	});

	test("isolates stored model state from the spawn request", async () => {
		const registry = new InMemoryV2AgentRegistry();
		const model = { provider: "test", id: "small" };
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "isolated",
			taskMessage: "start",
			model,
		});

		model.provider = "mutated";
		model.id = "changed";

		expect(await registry.list("session-1")).toEqual([child]);
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

	test("cleans up oldest terminal agents before enforcing total retention", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxTotalAgents: 2 });
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
		const third = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "third",
			taskMessage: "start",
			model: { provider: "test", id: "small" },
		});

		expect(await registry.list("session-1")).toEqual([second, third]);
		await expect(
			registry.spawn({
				sessionId: "session-1",
				parentPath: "/root",
				taskName: "fourth",
				taskMessage: "start",
				model: { provider: "test", id: "small" },
			}),
		).rejects.toThrow("total limit");
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
		["maxTotalAgents", 0],
		["maxTotalAgents", Number.POSITIVE_INFINITY],
	] as const)("rejects invalid %s limit (%s)", (name, value) => {
		expect(() => new InMemoryV2AgentRegistry({ [name]: value })).toThrow(name);
	});

	test("enforces separate per-parent and process-wide active limits", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxActive: 3, maxActivePerParent: 2 });
		const spawn = (sessionId: string, taskName: string, parentPath = "/root") =>
			registry.spawn({
				sessionId,
				parentPath,
				taskName,
				taskMessage: "work",
				model: { provider: "test", id: "small" },
			});
		await spawn("parent-a", "one");
		await spawn("parent-a", "two");
		await expect(spawn("parent-a", "three")).rejects.toThrow("for parent /root");
		await spawn("parent-b", "b-one", "/other");
		await expect(spawn("parent-b", "b-two", "/other")).rejects.toThrow("active limit 3");
	});

	test("does not share a parent quota between paths in one session", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxDepth: 2, maxActive: 4, maxActivePerParent: 1 });
		const spawn = (parentPath: string, taskName: string) =>
			registry.spawn({
				sessionId: "session-1",
				parentPath,
				taskName,
				taskMessage: "work",
				model: { provider: "test", id: "small" },
			});
		await spawn("/root", "one");
		await spawn("/root/other", "two");
		await expect(spawn("/root", "three")).rejects.toThrow("for parent /root");
	});

	test("rejects unsafe agent registry limits", () => {
		expect(() => new InMemoryV2AgentRegistry({ maxActive: 9 })).toThrow("maxActive must be an integer from 1 to 8");
		expect(() => new InMemoryV2AgentRegistry({ maxActivePerParent: 0 })).toThrow("maxActivePerParent");
		expect(() => new InMemoryV2AgentRegistry({ maxActivePerParent: 9 })).toThrow("maxActivePerParent");
	});

	test("interrupts running children during disposal", async () => {
		const registry = new InMemoryV2AgentRegistry();
		const child = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "worker",
			taskMessage: "long task",
			model: { provider: "test", id: "small" },
		});
		await registry.dispose!();
		expect(await registry.wait(child.id)).toMatchObject({ state: "interrupted" });
	});
});
