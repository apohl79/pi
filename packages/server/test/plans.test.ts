import { describe, expect, test } from "vitest";
import { InMemoryV2PlanRegistry } from "../src/plans.ts";

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
});
