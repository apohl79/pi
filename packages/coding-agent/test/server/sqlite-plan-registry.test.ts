import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteV2PlanRegistry } from "../../src/server/sqlite-plan-registry.ts";

const directories: string[] = [];
afterEach(async () =>
	Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

const items = [
	{ step: "Implement", status: "in_progress" as const },
	{ step: "Verify", status: "pending" as const },
];

describe("SqliteV2PlanRegistry", () => {
	test("restores versioned plans and clears them durably", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-plans-"));
		directories.push(directory);
		const path = join(directory, "plans.sqlite");
		const first = new SqliteV2PlanRegistry(path);
		expect(await first.update("session-1", { items })).toEqual({ version: 1, items });
		await first.close();

		const restored = new SqliteV2PlanRegistry(path);
		expect(await restored.read("session-1")).toEqual({ version: 1, items });
		await restored.clear("session-1");
		await restored.close();

		const empty = new SqliteV2PlanRegistry(path);
		expect(await empty.read("session-1")).toBeUndefined();
		await empty.close();
	});

	test("rejects malformed persisted plan rows", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-plans-invalid-"));
		directories.push(directory);
		const path = join(directory, "plans.sqlite");
		const database = await createNodeSqliteFactory().open(path);
		database.exec("CREATE TABLE v2_plans (session_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
		database
			.prepare("INSERT INTO v2_plans (session_id, value) VALUES (?, ?)")
			.run("session-1", JSON.stringify({ version: 0, items }));
		database.close();

		const plans = new SqliteV2PlanRegistry(path);
		await expect(plans.read("session-1")).rejects.toThrow("Plan version must be 1");
		await plans.close();
	});
});
