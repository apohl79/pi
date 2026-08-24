import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	CommandNameV2Schema,
	CommandV2Schema,
	decodeCbor,
	EventEnvelopeV2Schema,
	EventNameV2Schema,
	encodeCbor,
	encodeClientMessageV2,
	FrameDecoder,
	ImageContentSchema,
	isClientMessageV2,
	isServerMessageV2,
	OperationAcceptedSchema,
	PROTOCOL_V2_VERSION,
	PromptContentSchema,
	parseClientMessageV2,
	type SessionSnapshotV2,
	SessionSnapshotV2Schema,
} from "../src/index.ts";

const commandNames = [
	"session/list",
	"session/create",
	"session/attach",
	"session/detach",
	"session/read",
	"session/delete",
	"session/fork",
	"session/name/set",
	"session/name/generate",
	"session/name/auto/set",
	"turn/start",
	"turn/steer",
	"turn/followUp",
	"turn/queue/cancel",
	"turn/abort",
	"turn/resume",
	"turn/rollback",
	"turn/compact",
	"operation/read",
	"model/list",
	"session/model/set",
	"session/thinking/set",
	"session/steering-mode/set",
	"session/follow-up-mode/set",
	"session/compaction/set",
	"session/retry/set",
	"agent/spawn",
	"agent/list",
	"agent/wait",
	"agent/message",
	"agent/followUp",
	"agent/interrupt",
	"process/start",
	"process/list",
	"process/write",
	"process/wait",
	"process/terminate",
	"process/read",
	"input/request/read",
	"input/request/respond",
	"input/request/cancel",
	"plan/read",
	"plan/update",
	"plan/clear",
	"goal/read",
	"goal/create",
	"goal/update",
	"goal/pause",
	"goal/resume",
	"plugin/list",
	"plugin/read",
	"plugin/install",
	"plugin/upgrade",
	"plugin/uninstall",
	"plugin/enable",
	"plugin/disable",
	"marketplace/add",
	"marketplace/list",
	"marketplace/upgrade",
	"marketplace/remove",
	"app/list",
	"app/read",
	"app/auth/start",
	"app/auth/complete",
	"blob/put",
	"blob/read",
	"blob/stat",
	"filesystem/complete",
	"filesystem/reference/resolve",
	"filesystem/reference/read",
	"diagnostics/status",
	"diagnostics/timeline",
	"diagnostics/export",
	"diagnostics/verify",
	"diagnostics/doctor",
	"usage/read",
	"web",
	"image/view",
	"image/generate",
] as const;

const eventNames = [
	"server_snapshot",
	"session_snapshot",
	"session_delta",
	"operation_accepted",
	"operation_updated",
	"operation_terminal",
	"session_phase_changed",
	"session_name_updated",
	"turn_started",
	"item_completed",
	"tool_started",
	"tool_completed",
	"compaction_started",
	"compaction_completed",
	"recovery_report",
	"process_output",
	"process_terminal",
	"agent_updated",
	"agent_message",
	"plan_updated",
	"goal_updated",
	"model_instruction_profile_changed",
	"model_compaction_policy_changed",
	"input_request_updated",
	"usage_updated",
	"plugin_diagnostic",
	"connector_auth_changed",
	"diagnostics_degraded",
	"store_integrity_changed",
	"bundle_progress",
] as const;

const snapshot: SessionSnapshotV2 = {
	id: "session-1",
	name: "Contract session",
	nameSource: "explicit",
	nameRevision: 1,
	revision: 4,
	eventSeq: 9,
	phase: "idle",
	model: { provider: "test", id: "small" },
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
	diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 9 },
	persistence: { schemaVersion: 1, recoveryState: "clean" },
	createdAt: 1,
	updatedAt: 4,
};

describe("protocol v2 contract", () => {
	test("freezes the version and authoritative session cursor fields", () => {
		expect(PROTOCOL_V2_VERSION).toBe(2);
		expect(Check(SessionSnapshotV2Schema, snapshot)).toBe(true);
		expect(snapshot.eventSeq).toBeGreaterThan(snapshot.revision);
	});

	test("accepts bounded child usage and rejects malformed usage fields", () => {
		const agent = {
			id: "agent-1",
			path: "/root/worker",
			taskName: "worker",
			state: "running",
			model: { provider: "test", id: "small" },
			startedAt: 1_700_000_000_000,
			usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 0, costUsd: 0.12, pricingState: "known" },
		} as const;
		expect(Check(SessionSnapshotV2Schema, { ...snapshot, agents: [agent] })).toBe(true);
		expect(decodeCbor(encodeCbor({ ...snapshot, agents: [agent] }))).toEqual({ ...snapshot, agents: [agent] });
		expect(Check(SessionSnapshotV2Schema, { ...snapshot, agents: [{ ...agent, usage: { input: -1 } }] })).toBe(false);
		expect(Check(SessionSnapshotV2Schema, { ...snapshot, agents: [{ ...agent, startedAt: -1 }] })).toBe(false);
	});

	test("projects durable compaction summaries as transcript items", () => {
		const compaction = {
			id: "compaction-1",
			role: "compactionSummary",
			summary: "preserved history",
			tokensBefore: 420,
			timestamp: 1_700_000_000_001,
		} as const;
		const withCompaction = { ...snapshot, transcript: [compaction] };
		expect(Check(SessionSnapshotV2Schema, withCompaction)).toBe(true);
		expect(decodeCbor(encodeCbor(withCompaction))).toEqual(withCompaction);
		expect(
			Check(SessionSnapshotV2Schema, {
				...snapshot,
				transcript: [{ ...compaction, tokensBefore: -1 }],
			}),
		).toBe(false);
	});

	test("projects durable branch summaries as transcript items", () => {
		const branchSummary = {
			id: "branch-summary-1",
			role: "branchSummary",
			summary: "abandoned branch",
			fromId: "message-1",
			timestamp: 1_700_000_000_002,
		} as const;
		const withBranchSummary = { ...snapshot, transcript: [branchSummary] };
		expect(Check(SessionSnapshotV2Schema, withBranchSummary)).toBe(true);
		expect(decodeCbor(encodeCbor(withBranchSummary))).toEqual(withBranchSummary);
		expect(
			Check(SessionSnapshotV2Schema, {
				...snapshot,
				transcript: [{ ...branchSummary, fromId: "" }],
			}),
		).toBe(false);
	});

	test("accepts an operation request and durable acceptance response", () => {
		const request = {
			type: "request",
			id: "request-1",
			request: { command: "turn/start", sessionId: "session-1", payload: { text: "hello" } },
		} as const;
		const response = {
			type: "response",
			id: "request-1",
			ok: true,
			accepted: { operationId: "operation-1", sessionRevision: 5, eventSeq: 10 },
		} as const;

		expect(isClientMessageV2(request)).toBe(true);
		expect(isServerMessageV2(response)).toBe(true);
	});

	test("round-trips accepted compaction policy and rejects malformed policy values", () => {
		const accepted = {
			operationId: "operation-policy",
			sessionRevision: 3,
			eventSeq: 4,
			compactionPolicy: {
				enabled: true,
				contextWindow: 32_000,
				reserveTokens: 123,
				keepRecentTokens: 456,
				triggerTokens: 31_877,
				source: "mixed",
			},
		} as const;

		expect(Check(OperationAcceptedSchema, accepted)).toBe(true);
		expect(decodeCbor(encodeCbor(accepted))).toEqual(accepted);
		expect(
			Check(OperationAcceptedSchema, {
				...accepted,
				compactionPolicy: { ...accepted.compactionPolicy, reserveTokens: -1 },
			}),
		).toBe(false);
		expect(
			Check(OperationAcceptedSchema, {
				...accepted,
				compactionPolicy: { ...accepted.compactionPolicy, source: "invalid" },
			}),
		).toBe(false);
	});

	test("freezes every command and authoritative event name in the v2 contract", () => {
		expect(CommandNameV2Schema.anyOf.map((entry) => entry.const)).toEqual(commandNames);
		expect(EventNameV2Schema.anyOf.map((entry) => entry.const)).toEqual(eventNames);
		expect(commandNames.every((command) => Check(CommandNameV2Schema, command))).toBe(true);
		expect(eventNames.every((event) => Check(EventNameV2Schema, event))).toBe(true);
		expect(Check(CommandV2Schema, { command: "operation/read", sessionId: "session-1" })).toBe(true);
		expect(
			Check(EventEnvelopeV2Schema, {
				type: "event",
				sessionId: "session-1",
				seq: 10,
				revision: 5,
				event: "recovery_report",
				payload: { recoveryState: "clean" },
			}),
		).toBe(true);
	});

	test("accepts safe MIME tokens and rejects parameters or control characters", () => {
		expect(Check(ImageContentSchema, { type: "image", data: "abc", mimeType: "image/png" })).toBe(true);
		expect(Check(ImageContentSchema, { type: "image", data: "abc", mimeType: "image/svg+xml" })).toBe(true);
		expect(Check(ImageContentSchema, { type: "image", data: "abc", mimeType: "text/plain; charset=utf-8" })).toBe(
			false,
		);
		expect(Check(ImageContentSchema, { type: "image", data: "abc", mimeType: "text/plain\nX-Injected: yes" })).toBe(
			false,
		);
	});

	test("constrains V2 prompt reference MIME values", () => {
		expect(Check(PromptContentSchema, { type: "image", digest: "sha256:image", mimeType: "image/png" })).toBe(true);
		expect(Check(PromptContentSchema, { type: "blob", digest: "sha256:blob", mimeType: "text/plain" })).toBe(true);
		expect(Check(PromptContentSchema, { type: "image", digest: "sha256:image", mimeType: "text/plain" })).toBe(false);
		expect(
			Check(PromptContentSchema, { type: "blob", digest: "sha256:blob", mimeType: "text/plain\nX-Injected: yes" }),
		).toBe(false);
	});

	test("round-trips v2 messages through framed CBOR", () => {
		const request = {
			type: "request",
			id: "request-2",
			request: { command: "turn/start", sessionId: "session-1", payload: { text: "hello" } },
		} as const;
		const frame = encodeClientMessageV2(request);
		const decoder = new FrameDecoder();
		const [payload] = decoder.push(frame);

		expect(parseClientMessageV2(decodeCbor(payload))).toEqual(request);
	});

	test("round-trips a client diagnostic manifest and local cursor", () => {
		const hello = {
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			diagnostics: {
				manifest: { runtime: "node v22", platform: "linux", arch: "x64", forkCommit: "fork-sha" },
				afterSeq: 12,
			},
		} as const;
		const decoder = new FrameDecoder();
		const [payload] = decoder.push(encodeClientMessageV2(hello));
		expect(parseClientMessageV2(decodeCbor(payload))).toEqual(hello);
	});

	test("rejects v1 messages and unknown v2 fields", () => {
		expect(isClientMessageV2({ type: "hello", version: 1 })).toBe(false);
		expect(
			isClientMessageV2({
				type: "hello",
				version: PROTOCOL_V2_VERSION,
				unexpected: true,
			}),
		).toBe(false);
	});
});
