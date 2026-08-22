import { describe, expect, test } from "vitest";
import { GoalManager } from "../../src/harness/goals.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

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
});
