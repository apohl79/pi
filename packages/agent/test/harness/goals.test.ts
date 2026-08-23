import { describe, expect, test } from "vitest";
import { GoalManager } from "../../src/harness/goals.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import { createGoalTools } from "../../src/harness/tools/goals.ts";

describe("durable GoalManager", () => {
	test("persists goal lifecycle state through append-only session entries", async () => {
		let timestamp = 100;
		const storage = new InMemorySessionStorage({ id: "goal-session", createdAt: 1 });
		const session = new Session(storage);
		const goals = new GoalManager(session, () => timestamp++);
		const created = await goals.create("Finish the implementation", 10);
		const paused = await goals.pause();
		const resumed = await goals.resume();
		const limited = await goals.update({ tokensUsed: 11 });

		expect(created).toMatchObject({ objective: "Finish the implementation", status: "active", tokenBudget: 10 });
		expect(paused.status).toBe("paused");
		expect(resumed.status).toBe("active");
		expect(limited).toMatchObject({ tokensUsed: 11, status: "budgetLimited" });
		expect(await new GoalManager(new Session(storage), () => timestamp++).read()).toEqual(limited);
	});

	test("rejects duplicate or invalid goals", async () => {
		const manager = new GoalManager(new Session(new InMemorySessionStorage({ id: "goal-invalid", createdAt: 1 })));
		await expect(manager.create("", 1)).rejects.toThrow("must not be empty");
		await manager.create("one");
		await expect(manager.create("two")).rejects.toThrow("already exists");
		await expect(manager.update({ tokensUsed: -1 })).rejects.toThrow("non-negative");
	});

	test("serializes concurrent creates and updates across session instances", async () => {
		const storage = new InMemorySessionStorage({ id: "goal-concurrent", createdAt: 1 });
		const first = new GoalManager(new Session(storage), () => 10);
		const second = new GoalManager(new Session(storage), () => 20);

		const creates = await Promise.allSettled([first.create("one"), second.create("two")]);
		expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(creates.filter((result) => result.status === "rejected")[0]).toMatchObject({
			reason: expect.objectContaining({ message: "A goal already exists" }),
		});

		await Promise.all([first.update({ tokensUsed: 3, activeTimeSeconds: 4 }), second.update({ status: "paused" })]);
		expect(await first.read()).toMatchObject({
			tokensUsed: 3,
			activeTimeSeconds: 4,
			status: "paused",
		});
	});

	test("accrues active time only across active transitions", async () => {
		let timestamp = 1_000;
		const manager = new GoalManager(
			new Session(new InMemorySessionStorage({ id: "goal-time", createdAt: 1 })),
			() => timestamp,
		);
		await manager.create("Track time");
		timestamp = 6_000;
		const paused = await manager.pause();
		expect(paused.activeTimeSeconds).toBe(5);
		timestamp = 16_000;
		const resumed = await manager.resume();
		expect(resumed.activeTimeSeconds).toBe(5);
		timestamp = 18_000;
		const completed = await manager.update({ status: "complete" });
		expect(completed.activeTimeSeconds).toBe(7);
	});

	test("exposes model goal tools with restricted terminal updates", async () => {
		const manager = new GoalManager(new Session(new InMemorySessionStorage({ id: "goal-tools", createdAt: 1 })));
		const tools = createGoalTools(manager);
		const create = tools.find((tool) => tool.name === "create_goal");
		const read = tools.find((tool) => tool.name === "get_goal");
		const update = tools.find((tool) => tool.name === "update_goal");
		if (!create || !read || !update) throw new Error("Expected goal tools");
		await create.execute("create", { objective: "Ship the feature", token_budget: 10 }, undefined, undefined);
		expect((await read.execute("read", {}, undefined, undefined)).details.goal?.objective).toBe("Ship the feature");
		await expect(update.execute("update", { status: "complete" }, undefined, undefined)).resolves.toMatchObject({
			details: { goal: { status: "complete" } },
		});
	});
});
