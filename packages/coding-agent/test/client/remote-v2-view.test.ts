import type { SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { formatRemoteV2Session, type RemoteV2SessionViewOptions } from "../../src/client/remote-v2-view.ts";

const options: RemoteV2SessionViewOptions = { maxTranscriptItems: 1, maxTranscriptCharacters: 32 };
const snapshot: SessionSnapshotV2 = {
	id: "session-1",
	nameRevision: 0,
	revision: 2,
	eventSeq: 3,
	phase: "turn",
	model: { provider: "faux", id: "model" },
	thinkingLevel: "off",
	transcript: [
		{ id: "user-1", role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
		{
			id: "assistant-1",
			role: "assistant",
			status: "streaming",
			content: [{ type: "text", text: "a long assistant response" }],
			model: { provider: "faux", id: "model" },
			timestamp: 2,
		},
	],
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
	diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 3 },
	persistence: { schemaVersion: 1, recoveryState: "clean" },
	createdAt: 1,
	updatedAt: 2,
};

describe("formatRemoteV2Session", () => {
	test("renders current phase, model, bounded transcript, and operation state", () => {
		const output = formatRemoteV2Session(
			{ lifecycle: { status: "busy", operationId: "op-1", command: "turn/start" }, snapshot },
			options,
		);
		expect(output).toContain("Session session-1 · phase=turn · model=faux/model operation=op-1");
		expect(output).toContain("assistant: a long assistant");
		expect(output).toContain("…");
		expect(output).not.toContain("user: old");
	});

	test("renders detached state without fabricating a snapshot", () => {
		expect(formatRemoteV2Session({ lifecycle: { status: "detached" } }, options)).toBe("Session detached");
	});
});
