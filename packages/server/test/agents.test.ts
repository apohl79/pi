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
		expect(await registry.wait(child.id)).toMatchObject({ state: "running" });
	});
});
