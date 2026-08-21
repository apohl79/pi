import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	isOperationRecordV2,
	MAX_V2_ARRAY_ITEMS,
	MAX_V2_STRING_LENGTH,
	OperationRecordV2Schema,
	OperationSummarySchema,
	PromptContentSchema,
	QueueSnapshotSchema,
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
		expect(Check(OperationRecordV2Schema, { ...accepted, state: "complete" })).toBe(false);
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
	});
});
