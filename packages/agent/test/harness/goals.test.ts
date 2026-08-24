import { describe, expect, test } from "vitest";
import { GoalContinuationScheduler, GoalManager } from "../../src/harness/goals.ts";
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
		await expect(manager.create("unsafe", Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow("safe integer");
		await manager.create("one");
		await expect(manager.create("two")).rejects.toThrow("already exists");
		await expect(manager.update({ tokensUsed: -1 })).rejects.toThrow("non-negative");
		await expect(manager.update({ tokensUsed: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("safe integer");
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
		expect(create).toBeDefined();
		expect(read).toBeDefined();
		expect(update).toBeDefined();
		const createTool = create as NonNullable<typeof create>;
		const readTool = read as NonNullable<typeof read>;
		const updateTool = update as NonNullable<typeof update>;
		await createTool.execute("create", { objective: "Ship the feature", token_budget: 10 }, undefined, undefined);
		expect((await readTool.execute("read", {}, undefined, undefined)).details.goal?.objective).toBe(
			"Ship the feature",
		);
		await expect(updateTool.execute("update", { status: "complete" }, undefined, undefined)).resolves.toMatchObject({
			details: { goal: { status: "complete" } },
		});
	});

	test("schedules one continuation only while the goal is active", async () => {
		const manager = new GoalManager(
			new Session(new InMemorySessionStorage({ id: "goal-continuation", createdAt: 1 })),
		);
		const goal = await manager.create("Continue the implementation");
		const callbacks: Array<() => void | Promise<void>> = [];
		const continued: string[] = [];
		let release!: () => void;
		const scheduler = new GoalContinuationScheduler({
			goals: manager,
			waitForIdle: async (callback) => {
				callbacks.push(callback);
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			continueGoal: async (current) => {
				continued.push(current.id);
			},
			maxContinuations: 1,
		});
		const first = scheduler.schedule();
		expect(await scheduler.schedule()).toBe(false);
		await callbacks[0]!();
		release();
		expect(await first).toBe(true);
		expect(continued).toEqual([goal.id]);
		expect(await scheduler.schedule()).toBe(false);
		await manager.pause();
		scheduler.close();
	});

	test("attributes provider tokens and stops at the token budget", async () => {
		const manager = new GoalManager(new Session(new InMemorySessionStorage({ id: "goal-usage", createdAt: 1 })));
		await manager.create("Bound the work", 10);
		const exhausted = await manager.recordUsage(10);
		expect(exhausted).toMatchObject({ tokensUsed: 10, status: "budgetLimited" });
		const limited = await manager.recordUsage(1);
		expect(limited).toMatchObject({ tokensUsed: 11, status: "budgetLimited" });
		await expect(manager.recordUsage(1)).resolves.toMatchObject({ tokensUsed: 12, status: "budgetLimited" });
	});
});
