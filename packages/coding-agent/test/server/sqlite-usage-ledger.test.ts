import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteV2UsageLedger } from "../../src/server/sqlite-usage-ledger.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function entry(responseId: string, output: number) {
	return {
		responseId,
		sessionId: "session-1",
		agentId: "agent-1",
		operationId: "operation-1",
		purpose: "agent" as const,
		provider: "test-provider",
		model: "test-model",
		input: 10,
		output,
		cacheRead: 2,
		cacheWrite: 1,
		pricing: "providerReported" as const,
		costUsd: output / 100,
		createdAt: 1,
	};
}

describe("SqliteV2UsageLedger", () => {
	test("serializes concurrent writes, upserts response IDs, and restores filters", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-usage-"));
		directories.push(directory);
		const path = join(directory, "usage.sqlite");
		const first = new SqliteV2UsageLedger(createNodeSqliteFactory(), path);
		await Promise.all([first.record(entry("response-1", 20)), first.record(entry("response-2", 30))]);
		await first.record(entry("response-1", 25));
		expect(await first.read({ provider: "test-provider" })).toHaveLength(2);
		expect(await first.aggregate({ sessionId: "session-1" })).toMatchObject({
			responses: 2,
			output: 55,
			costUsd: 0.55,
		});
		await first.close();

		const restored = new SqliteV2UsageLedger(createNodeSqliteFactory(), path);
		expect(await restored.read()).toEqual([entry("response-1", 25), entry("response-2", 30)]);
		await restored.close();
	});
});
