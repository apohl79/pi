import type { SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { sessionStatus } from "../../src/client/remote-v2-selector.ts";

function snapshot(overrides: Partial<SessionSnapshotV2> = {}): SessionSnapshotV2 {
	return {
		id: "session-1",
		nameRevision: 0,
		revision: 1,
		eventSeq: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		transcript: [],
		queues: { steer: [], followUp: [] },
		agents: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingState: "known" },
		context: { inputTokens: 0, contextWindow: 16_000, usedPercentage: 0 },
		compactionPolicy: {
			enabled: true,
			contextWindow: 16_000,
			reserveTokens: 1_000,
			keepRecentTokens: 2_000,
			triggerTokens: 15_000,
			source: "global",
		},
		pluginSetHash: "plugins-empty",
		diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 1 },
		persistence: { schemaVersion: 1, recoveryState: "clean" },
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("sessionStatus", () => {
	test.each([
		["idle", "idle"],
		["turn", "running"],
		["compaction", "running"],
		["awaitingInput", "awaiting-input"],
		["suspended", "suspended"],
		["failed", "failed"],
	] as const)("maps %s phase to %s", (phase, status) => {
		expect(sessionStatus(snapshot({ phase }))).toBe(status);
	});

	test("prioritizes an active goal while the session is idle", () => {
		expect(
			sessionStatus(
				snapshot({
					goal: {
						id: "goal-1",
						objective: "ship",
						status: "active",
						tokensUsed: 0,
						activeTimeSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				}),
			),
		).toBe("goal-active");
	});
});
