import type { SessionSnapshotV2 } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { RemoteV2SessionState } from "../../src/client/remote-v2-session.ts";
import {
	createRemoteV2StatuslinePayload,
	formatRemoteV2Session,
	type RemoteV2SessionViewOptions,
	RemoteV2StatuslineComponent,
	RemoteV2StatuslineController,
} from "../../src/client/remote-v2-view.ts";
import { StatuslineRunner } from "../../src/server/statusline.ts";

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
							startedAt: Date.now() - 102_000,
							usage: {
								input: 38_000,
								output: 4_200,
								cacheRead: 0,
								cacheWrite: 0,
								costUsd: 0.71,
								pricingState: "known",
							},
						},
					],
				},
			},
			{ maxAgentItems: 1 },
		);
		expect(output).toMatch(/Agent \/root\/worker · running · anthropic\/sonnet · 01:4[12] · ↓38000 ↑4200 \$0\.71/);
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

	test("uses the snapshot operation after reattach", () => {
		const output = formatRemoteV2Session({
			lifecycle: { status: "ready" },
			snapshot: {
				...snapshot,
				activeOperation: {
					operationId: "op-reconnected",
					kind: "turn/start",
					state: "running",
					acceptedSeq: 4,
				},
			},
		});
		expect(output).toContain("operation=op-reconnected (running)");
	});

	test("projects authoritative state into the statusline payload", () => {
		const payload = createRemoteV2StatuslinePayload(
			{
				lifecycle: { status: "ready" },
				snapshot: {
					...snapshot,
					name: "Remote task",
					usage: { ...snapshot.usage, input: 8, output: 3, costUsd: 0.42 },
					context: { ...snapshot.context, usedPercentage: 25 },
					goal: {
						id: "goal",
						objective: "task",
						status: "active",
						tokenBudget: 20,
						tokensUsed: 5,
						activeTimeSeconds: 1,
						createdAt: 1,
						updatedAt: 1,
					},
					plan: {
						version: 1,
						items: [
							{ step: "done", status: "completed" },
							{ step: "next", status: "pending" },
						],
					},
					agents: [
						{
							id: "agent",
							path: "/root/agent",
							taskName: "agent",
							state: "running",
							model: { provider: "faux", id: "model" },
						},
					],
				},
			},
			{ cwd: "/work", transcriptPath: "/tmp/session.jsonl", projectDir: "/work", addedDirs: ["/shared"] },
		);
		expect(payload).toMatchObject({
			harness: "pi",
			session_id: "session-1",
			session_name: "Remote task",
			cost: { total_cost_usd: 0.42, pricing_state: "known" },
			context_window: { total_input_tokens: 8, total_output_tokens: 3, remaining_percentage: 75 },
			task_indicator: { text: "Tasks 1/2", completed: 1, total: 2 },
			goal: { status: "active", remaining_tokens: 15 },
			agents: { active: 1, total: 1 },
			server: { connected: true, phase: "turn", detachable: true },
		});
	});

	test("executes the statusline locally from remote snapshot state", async () => {
		let listener: ((state: RemoteV2SessionState) => void) | undefined;
		const source: {
			readonly state: RemoteV2SessionState;
			subscribe(callback: (state: RemoteV2SessionState) => void): () => void;
		} = {
			state: { lifecycle: { status: "ready" as const }, snapshot },
			subscribe: (callback: (state: RemoteV2SessionState) => void) => {
				listener = callback;
				callback(source.state);
				return () => {
					listener = undefined;
				};
			},
		};
		const payloads: unknown[] = [];
		const runner = new StatuslineRunner({
			command: "statusline.sh",
			execute: async (_command, payload) => {
				payloads.push(JSON.parse(payload));
				return { stdout: "remote status", stderr: "", exitCode: 0 };
			},
		});
		const controller = new RemoteV2StatuslineController(source, runner, {
			cwd: "/work",
			transcriptPath: "/tmp/session.jsonl",
		});
		try {
			await controller.refresh();
			expect(controller.snapshot.output).toBe("remote status");
			expect(payloads).toHaveLength(1);
			expect(payloads[0]).toMatchObject({ harness: "pi", session_id: "session-1", server: { connected: true } });
			listener?.({ lifecycle: { status: "ready" }, snapshot: { ...snapshot, revision: 3 } });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(payloads).toHaveLength(1);
		} finally {
			await controller.dispose();
		}
	});

	test("renders the local statusline component from remote state", async () => {
		const source = {
			state: { lifecycle: { status: "ready" as const }, snapshot },
			subscribe: (callback: (state: RemoteV2SessionState) => void) => {
				callback(source.state);
				return () => {};
			},
		};
		const runner = new StatuslineRunner({
			command: "statusline.sh",
			execute: async () => ({ stdout: "remote status\nignored", stderr: "", exitCode: 0 }),
		});
		let updates = 0;
		const component = new RemoteV2StatuslineComponent(source, runner, { cwd: "/work", transcriptPath: "" }, () => {
			updates += 1;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(component.render(80)).toEqual(["remote status"]);
		expect(updates).toBe(1);
		component.dispose();
	});
});
