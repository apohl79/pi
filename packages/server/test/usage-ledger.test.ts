import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InMemoryV2UsageLedger, JsonlV2UsageLedger, type V2UsageLedgerEntry } from "../src/usage-ledger.ts";

const baseEntry: V2UsageLedgerEntry = {
	responseId: "response-1",
	sessionId: "session-1",
	agentId: "agent-1",
	operationId: "operation-1",
	purpose: "agent",
	provider: "test",
	model: "small",
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	pricing: "catalog",
	priceSnapshot: { input: 1 },
	costUsd: 0.25,
	createdAt: 1,
};

describe("V2 usage ledger", () => {
	test("upserts response identity and aggregates attributable dimensions", async () => {
		const ledger = new InMemoryV2UsageLedger();
		await ledger.record(baseEntry);
		await ledger.record({
			...baseEntry,
			responseId: "response-2",
			purpose: "compaction",
			input: 4,
			costUsd: 0.5,
			pricing: "subscription",
			imageUnits: 2,
		});
		await ledger.record({ ...baseEntry, responseId: "response-1", input: 11 });

		expect(await ledger.aggregate({ sessionId: "session-1" })).toMatchObject({
			responses: 2,
			input: 15,
			output: 10,
			imageUnits: 2,
			pricingState: "subscription",
			costUsd: 0.75,
		});
		expect(await ledger.aggregate({ purpose: "agent" })).toMatchObject({ responses: 1, input: 11 });
	});

	test("recovers durable entries and preserves unknown pricing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-usage-ledger-"));
		const path = join(directory, "nested", "usage.jsonl");
		const first = new JsonlV2UsageLedger(path);
		await first.record({ ...baseEntry, pricing: "unknown", costUsd: undefined });
		const reopened = new JsonlV2UsageLedger(path);
		expect(await reopened.aggregate()).toMatchObject({ responses: 1, pricingState: "unknown" });
	});

	test("rejects negative usage values", async () => {
		await expect(new InMemoryV2UsageLedger().record({ ...baseEntry, input: -1 })).rejects.toThrow(
			"Usage field is invalid",
		);
	});

	test("does not publish usage when the durable append fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-usage-ledger-failure-"));
		const blocker = join(directory, "parent-file");
		await writeFile(blocker, "not a directory");
		const ledger = new JsonlV2UsageLedger(join(blocker, "usage.jsonl"));

		await expect(ledger.record(baseEntry)).rejects.toThrow();
		expect(await ledger.read()).toEqual([]);
	});
});
