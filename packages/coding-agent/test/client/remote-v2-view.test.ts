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

	test("strips ANSI and control characters from remote transcript text", () => {
		const unsafe = structuredClone(snapshot);
		unsafe.transcript = [
			{
				...unsafe.transcript[1]!,
				content: [{ type: "text", text: "\u001b[31mred\u001b[0m\u0000\u0007 text" }],
			},
		];
		const output = formatRemoteV2Session({ lifecycle: { status: "ready" }, snapshot: unsafe }, options);
		expect(output).toContain("assistant: red text");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u0000");
	});

	test("normalizes transcript limits before slicing", () => {
		const output = formatRemoteV2Session(
			{ lifecycle: { status: "ready" }, snapshot },
			{ maxTranscriptItems: Number.POSITIVE_INFINITY, maxTranscriptCharacters: -10 },
		);
		expect(output).not.toContain("assistant:");
	});

	test("renders no transcript items when the item limit is zero", () => {
		const output = formatRemoteV2Session(
			{ lifecycle: { status: "ready" }, snapshot },
			{ maxTranscriptItems: 0, maxTranscriptCharacters: 10_000 },
		);
		expect(output).not.toContain("assistant:");
		expect(output).not.toContain("user:");
	});

	test("sanitizes remote-derived header fields", () => {
		const unsafe = structuredClone(snapshot);
		unsafe.id = "session-\u001b[31m1";
		unsafe.phase = "turn\u0000";
		unsafe.model = { provider: "faux\u0007", id: "model\u001b[0m" };
		const output = formatRemoteV2Session(
			{ lifecycle: { status: "busy", operationId: "op-\u001b[2K1", command: "turn/start" }, snapshot: unsafe },
			options,
		);
		expect(output).toContain("Session session-1 · phase=turn · model=faux/model operation=op-1");
		expect(output).not.toMatch(/[\u0000\u0007\u001b]/);
	});

	test("renders bounded active-agent summaries", () => {
		const output = formatRemoteV2Session(
			{
				lifecycle: { status: "ready" },
				snapshot: {
					...snapshot,
					agents: [
						{
							id: "agent-1",
							path: "/root/worker",
							taskName: "worker",
							state: "running",
							model: { provider: "anthropic", id: "sonnet" },
						},
					],
				},
			},
			{ maxAgentItems: 1 },
		);
		expect(output).toContain("Agent /root/worker · running · anthropic/sonnet");
	});

	test("renders authoritative goal and plan state", () => {
		const output = formatRemoteV2Session({
			lifecycle: { status: "ready" },
			snapshot: {
				...snapshot,
				goal: {
					id: "goal-1",
					objective: "finish the remote implementation",
					status: "active",
					tokensUsed: 4,
					activeTimeSeconds: 2,
					createdAt: 1,
					updatedAt: 2,
				},
				plan: {
					version: 3,
					items: [{ step: "verify the daemon", status: "in_progress" }],
				},
			},
		});
		expect(output).toContain("Goal active · finish the remote implementation");
		expect(output).toContain("Plan v3");
		expect(output).toContain("Plan in_progress · verify the daemon");
	});

	test("applies an aggregate character budget to plan lines", () => {
		const output = formatRemoteV2Session(
			{
				lifecycle: { status: "ready" },
				snapshot: {
					...snapshot,
					plan: {
						version: 1,
						items: Array.from({ length: 1000 }, () => ({ step: "x".repeat(10_000), status: "pending" as const })),
					},
				},
			},
			{ maxPlanItems: 1000, maxPlanCharacters: 100 },
		);
		const planLines = output.split("\n").filter((line) => line.startsWith("Plan "));
		expect(planLines.join("\n").length).toBeLessThanOrEqual(108);
	});

	test("renders a pending structured input request", () => {
		const output = formatRemoteV2Session({
			lifecycle: { status: "ready" },
			snapshot: { ...snapshot, queues: { ...snapshot.queues, pendingInputRequestId: "input-1" } },
		});
		expect(output).toContain("Input request pending · input-1");
	});

	test("renders usage and degraded recovery indicators without guessing cost", () => {
		const output = formatRemoteV2Session({
			lifecycle: { status: "ready" },
			snapshot: {
				...snapshot,
				usage: { ...snapshot.usage, input: 8, output: 3, cacheRead: 2, pricingState: "unknown" },
				persistence: { ...snapshot.persistence, recoveryState: "needsResolution" },
				diagnostics: { ...snapshot.diagnostics, degraded: true },
			},
		});
		expect(output).toContain("Usage input=8 output=3 cacheRead=2 cost=unknown");
		expect(output).toContain("Persistence needsResolution");
		expect(output).toContain("Diagnostics degraded");
	});
});
