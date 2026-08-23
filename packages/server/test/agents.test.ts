import { describe, expect, test } from "vitest";
import { InMemoryV2AgentRegistry } from "../src/agents.ts";

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

		expect(child).toMatchObject({
			path: "/root/research",
			state: "running",
			taskName: "research",
			startedAt: expect.any(Number),
		});
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
		expect(await registry.wait(child.id)).toMatchObject({ state: "running" });
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

	test("enforces the process limit when a terminal child receives a follow-up", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxActive: 1 });
		const first = await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "first",
			taskMessage: "finish first",
			model: { provider: "test", id: "small" },
		});
		await registry.interrupt(first.id);
		await registry.spawn({
			sessionId: "session-1",
			parentPath: "/root",
			taskName: "second",
			taskMessage: "keep the slot",
			model: { provider: "test", id: "small" },
		});
		await expect(registry.followUp(first.id, "must wait")).rejects.toThrow("active limit 1");
	});

	test("preserves registry invariants across a deterministic lifecycle state machine", async () => {
		const registry = new InMemoryV2AgentRegistry({ maxActive: 2, maxActivePerParent: 2 });
		const model = { provider: "test", id: "small" };
		const spawn = (taskName: string) =>
			registry.spawn({
				sessionId: "session-1",
				parentPath: "/root",
				taskName,
				taskMessage: `work:${taskName}`,
				model,
			});
		const first = await spawn("first");
		const second = await spawn("second");
		const assertInvariants = async (expectedActive: number) => {
			const snapshots = await registry.list("session-1");
			expect(new Set(snapshots.map((agent) => agent.path)).size).toBe(snapshots.length);
			expect(snapshots.filter((agent) => agent.state === "running")).toHaveLength(expectedActive);
			expect(snapshots.every((agent) => agent.path.startsWith("/root/"))).toBe(true);
		};

		await assertInvariants(2);
		await expect(spawn("third")).rejects.toThrow("active limit 2");
		await registry.complete(first.id);
		await assertInvariants(1);
		await expect(registry.followUp(first.id, "resume while second runs")).resolves.toMatchObject({
			state: "running",
		});
		await assertInvariants(2);
		await registry.interrupt(second.id);
		await assertInvariants(1);
		await registry.complete(first.id);
		await assertInvariants(0);
		await expect(registry.followUp(first.id, "resume first")).resolves.toMatchObject({ state: "running" });
		await assertInvariants(1);
		await registry.interrupt(first.id);
		await assertInvariants(0);
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
		await expect(spawn("/root/", "three")).rejects.toThrow("for parent /root");
	});

	test("rejects unsafe agent registry limits", () => {
		expect(() => new InMemoryV2AgentRegistry({ maxActive: 9 })).toThrow("maxActive must be an integer from 1 to 8");
		expect(() => new InMemoryV2AgentRegistry({ maxDepth: Number.MAX_SAFE_INTEGER + 1 })).toThrow("maxDepth");
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
