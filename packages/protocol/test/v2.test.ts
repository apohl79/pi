import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	isOperationRecordV2,
	isOperationSummary,
	MAX_V2_ARRAY_ITEMS,
	MAX_V2_STRING_LENGTH,
	OperationRecordV2Schema,
	OperationSummarySchema,
	PromptContentSchema,
	QueueSnapshotSchema,
	ServerSnapshotV2Schema,
	SessionSnapshotV2Schema,
} from "../src/index.ts";

describe("protocol v2 contract schemas", () => {
	test("requires canonical digests and safe MIME tokens", () => {
		expect(Check(PromptContentSchema, { type: "image", digest: "a".repeat(64), mimeType: "image/png" })).toBe(true);
		expect(Check(PromptContentSchema, { type: "image", digest: "A".repeat(64), mimeType: "image/png" })).toBe(false);
		expect(
			Check(PromptContentSchema, { type: "image", digest: "a".repeat(64), mimeType: "image/png; charset=utf-8" }),
		).toBe(false);
	});

	test("bounds untrusted v2 strings and arrays", () => {
		expect(Check(PromptContentSchema, { type: "text", text: "x".repeat(MAX_V2_STRING_LENGTH) })).toBe(true);
		expect(Check(PromptContentSchema, { type: "text", text: "x".repeat(MAX_V2_STRING_LENGTH + 1) })).toBe(false);
		expect(
			Check(QueueSnapshotSchema, {
				steer: [],
				followUp: Array.from({ length: MAX_V2_ARRAY_ITEMS + 1 }, () => ({
					id: "q",
					content: [{ type: "text", text: "x" }],
					createdAt: 0,
				})),
			}),
		).toBe(false);
	});

	test("requires terminal sequence only for terminal operation states", () => {
		const accepted = {
			operationId: "op-1",
			sessionId: "session-1",
			state: "accepted",
			accepted: { operationId: "op-1", sessionRevision: 0, eventSeq: 1 },
		};
		expect(Check(OperationRecordV2Schema, accepted)).toBe(true);
		expect(Check(OperationRecordV2Schema, { ...accepted, terminalSeq: 2 })).toBe(false);
		expect(Check(OperationRecordV2Schema, { ...accepted, state: "complete", terminalSeq: 2 })).toBe(true);
		expect(Check(OperationRecordV2Schema, { ...accepted, state: "complete" })).toBe(true);
	});

	test("requires operation IDs to match between record and accepted entry", () => {
		const record = {
			operationId: "op-1",
			sessionId: "session-1",
			state: "accepted",
			accepted: { operationId: "op-1", sessionRevision: 0, eventSeq: 1 },
		};
		expect(isOperationRecordV2(record)).toBe(true);
		expect(isOperationRecordV2({ ...record, accepted: { ...record.accepted, operationId: "op-2" } })).toBe(false);
	});

	test("rejects terminal sequences before accepted sequences", () => {
		const summary = { operationId: "op-1", kind: "prompt", state: "failed", acceptedSeq: 3, terminalSeq: 2 };
		const record = {
			operationId: "op-1",
			sessionId: "session-1",
			state: "failed",
			accepted: { operationId: "op-1", sessionRevision: 0, eventSeq: 3 },
			terminalSeq: 2,
		};
		expect(Check(OperationSummarySchema, summary)).toBe(true);
		expect(isOperationSummary(summary)).toBe(false);
		expect(isOperationRecordV2(record)).toBe(false);
	});

	test("bounds nested v2 model and transcript payloads", () => {
		const model = {
			provider: "provider",
			id: "model",
			name: "name",
			api: "api",
			reasoning: false,
			input: ["text"],
			contextWindow: 1,
			maxTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			supportedThinkingLevels: ["off"],
			authenticated: false,
		};
		const server = {
			serverId: "server",
			protocolVersion: 2,
			revision: 0,
			eventSeq: 0,
			sessions: [],
			models: [model],
		};
		expect(Check(ServerSnapshotV2Schema, server)).toBe(true);
		expect(
			Check(ServerSnapshotV2Schema, {
				...server,
				models: [{ ...model, name: "x".repeat(MAX_V2_STRING_LENGTH + 1) }],
			}),
		).toBe(false);
		expect(
			Check(ServerSnapshotV2Schema, {
				...server,
				models: [{ ...model, input: Array.from({ length: MAX_V2_ARRAY_ITEMS + 1 }, () => "text") }],
			}),
		).toBe(false);

		const snapshot = {
			id: "session",
			nameRevision: 0,
			revision: 0,
			eventSeq: 0,
			phase: "idle",
			model: { provider: "provider", id: "model" },
			thinkingLevel: "off",
			transcript: [{ id: "item", role: "user", content: [{ type: "text", text: "ok" }], timestamp: 0 }],
			queues: { steer: [], followUp: [] },
			agents: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingState: "unknown" },
			context: { inputTokens: 0, contextWindow: 1, usedPercentage: 0 },
			compactionPolicy: {
				enabled: false,
				contextWindow: 1,
				reserveTokens: 0,
				keepRecentTokens: 0,
				triggerTokens: 0,
				source: "global",
			},
			pluginSetHash: "plugins",
			diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 0 },
			persistence: { schemaVersion: 0, recoveryState: "clean" },
			createdAt: 0,
			updatedAt: 0,
		};
		expect(Check(SessionSnapshotV2Schema, snapshot)).toBe(true);
		expect(
			Check(SessionSnapshotV2Schema, {
				...snapshot,
				transcript: [
					{ ...snapshot.transcript[0], content: [{ type: "text", text: "x".repeat(MAX_V2_STRING_LENGTH + 1) }] },
				],
			}),
		).toBe(false);
		const toolItem = {
			id: "tool-item",
			role: "tool",
			toolCallId: "call",
			toolName: "tool",
			input: {},
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
			status: "complete",
			isError: false,
		};
		expect(Check(SessionSnapshotV2Schema, { ...snapshot, transcript: [toolItem] })).toBe(true);
		expect(
			Check(SessionSnapshotV2Schema, {
				...snapshot,
				transcript: [
					{
						...toolItem,
						input: Object.fromEntries(
							Array.from({ length: MAX_V2_ARRAY_ITEMS + 1 }, (_, index) => [`key-${index}`, true]),
						),
					},
				],
			}),
		).toBe(false);
	}, 15_000);

	test("requires terminal sequence in terminal summaries", () => {
		expect(
			Check(OperationSummarySchema, { operationId: "op-1", kind: "prompt", state: "running", acceptedSeq: 1 }),
		).toBe(true);
		expect(
			Check(OperationSummarySchema, {
				operationId: "op-1",
				kind: "prompt",
				state: "running",
				acceptedSeq: 1,
				terminalSeq: 2,
			}),
		).toBe(false);
		expect(
			Check(OperationSummarySchema, {
				operationId: "op-1",
				kind: "prompt",
				state: "failed",
				acceptedSeq: 1,
				terminalSeq: 2,
			}),
		).toBe(true);
		expect(
			Check(OperationSummarySchema, { operationId: "op-1", kind: "prompt", state: "failed", acceptedSeq: 1 }),
		).toBe(true);
	});
});
