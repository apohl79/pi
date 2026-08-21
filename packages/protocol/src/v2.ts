import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { ModelMetadataSchema, ModelRefSchema, ThinkingLevelSchema, TranscriptItemSchema } from "./schemas.ts";

export const PROTOCOL_V2_VERSION = 2 as const;

export const MAX_V2_STRING_LENGTH = 1_048_576;
export const MAX_V2_ARRAY_ITEMS = 10_000;

const BoundedStringSchema = Type.String({ maxLength: MAX_V2_STRING_LENGTH });
const IdSchema = Type.String({ minLength: 1, maxLength: 256 });
const DigestSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const MimeTypeSchema = Type.String({
	pattern: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$",
	maxLength: 127,
});
const TimestampSchema = Type.Integer({ minimum: 0 });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const SessionPhaseV2Schema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("awaitingInput"),
	Type.Literal("suspended"),
	Type.Literal("failed"),
]);
export type SessionPhaseV2 = Static<typeof SessionPhaseV2Schema>;

export const OperationStateSchema = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("running"),
	Type.Literal("complete"),
	Type.Literal("failed"),
	Type.Literal("aborted"),
	Type.Literal("suspended"),
]);
export type OperationState = Static<typeof OperationStateSchema>;

const NonTerminalOperationSummarySchema = StrictObject({
	operationId: IdSchema,
	kind: Type.String({ minLength: 1, maxLength: 256 }),
	state: Type.Union([Type.Literal("accepted"), Type.Literal("running")]),
	acceptedSeq: NonNegativeIntegerSchema,
});
const TerminalOperationSummarySchema = StrictObject({
	operationId: IdSchema,
	kind: Type.String({ minLength: 1, maxLength: 256 }),
	state: Type.Union([
		Type.Literal("complete"),
		Type.Literal("failed"),
		Type.Literal("aborted"),
		Type.Literal("suspended"),
	]),
	acceptedSeq: NonNegativeIntegerSchema,
	terminalSeq: NonNegativeIntegerSchema,
});
export const OperationSummarySchema = Type.Union([NonTerminalOperationSummarySchema, TerminalOperationSummarySchema]);
export type OperationSummary = Static<typeof OperationSummarySchema>;

export const OperationAcceptedSchema = StrictObject({
	operationId: IdSchema,
	sessionRevision: NonNegativeIntegerSchema,
	eventSeq: NonNegativeIntegerSchema,
});
export type OperationAccepted = Static<typeof OperationAcceptedSchema>;

const NonTerminalOperationRecordSchema = StrictObject({
	operationId: IdSchema,
	sessionId: IdSchema,
	state: Type.Union([Type.Literal("accepted"), Type.Literal("running")]),
	accepted: OperationAcceptedSchema,
});
const TerminalOperationRecordSchema = StrictObject({
	operationId: IdSchema,
	sessionId: IdSchema,
	state: Type.Union([
		Type.Literal("complete"),
		Type.Literal("failed"),
		Type.Literal("aborted"),
		Type.Literal("suspended"),
	]),
	accepted: OperationAcceptedSchema,
	terminalSeq: NonNegativeIntegerSchema,
	error: Type.Optional(BoundedStringSchema),
});
export const OperationRecordV2Schema = Type.Union([NonTerminalOperationRecordSchema, TerminalOperationRecordSchema]);
export type OperationRecordV2 = Static<typeof OperationRecordV2Schema>;

export const EventCursorSchema = StrictObject({
	sessionId: IdSchema,
	eventSeq: NonNegativeIntegerSchema,
});
export type EventCursor = Static<typeof EventCursorSchema>;

export const PromptContentSchema = Type.Union([
	StrictObject({ type: Type.Literal("text"), text: BoundedStringSchema }),
	StrictObject({ type: Type.Literal("image"), digest: DigestSchema, mimeType: MimeTypeSchema }),
	StrictObject({ type: Type.Literal("blob"), digest: DigestSchema, mimeType: MimeTypeSchema }),
]);

export const QueuedInputSchema = StrictObject({
	id: IdSchema,
	content: Type.Array(PromptContentSchema, { minItems: 1, maxItems: MAX_V2_ARRAY_ITEMS }),
	createdAt: TimestampSchema,
});

export const QueueSnapshotSchema = StrictObject({
	steer: Type.Array(QueuedInputSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	followUp: Type.Array(QueuedInputSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	pendingInputRequestId: Type.Optional(IdSchema),
});

export const PlanItemSchema = StrictObject({
	step: Type.String({ minLength: 1, maxLength: MAX_V2_STRING_LENGTH }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
});
export type PlanItem = Static<typeof PlanItemSchema>;

export const PlanSnapshotSchema = StrictObject({
	version: NonNegativeIntegerSchema,
	items: Type.Array(PlanItemSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
});
export type PlanSnapshot = Static<typeof PlanSnapshotSchema>;

export const GoalStatusSchema = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("blocked"),
	Type.Literal("usageLimited"),
	Type.Literal("budgetLimited"),
	Type.Literal("complete"),
]);

export const GoalSnapshotSchema = StrictObject({
	id: IdSchema,
	objective: Type.String({ minLength: 1, maxLength: MAX_V2_STRING_LENGTH }),
	status: GoalStatusSchema,
	tokenBudget: Type.Optional(NonNegativeIntegerSchema),
	tokensUsed: NonNegativeIntegerSchema,
	activeTimeSeconds: Type.Number({ minimum: 0 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});
export type GoalSnapshot = Static<typeof GoalSnapshotSchema>;

export const AgentSummarySchema = StrictObject({
	id: IdSchema,
	path: IdSchema,
	taskName: Type.String({ minLength: 1, maxLength: 256 }),
	state: Type.Union([
		Type.Literal("idle"),
		Type.Literal("running"),
		Type.Literal("awaitingInput"),
		Type.Literal("complete"),
		Type.Literal("failed"),
		Type.Literal("interrupted"),
	]),
	model: ModelRefSchema,
});
export type AgentSummary = Static<typeof AgentSummarySchema>;

export const UsageAggregateSchema = StrictObject({
	input: NonNegativeIntegerSchema,
	output: NonNegativeIntegerSchema,
	cacheRead: NonNegativeIntegerSchema,
	cacheWrite: NonNegativeIntegerSchema,
	costUsd: Type.Optional(Type.Number({ minimum: 0 })),
	pricingState: Type.Union([Type.Literal("known"), Type.Literal("unknown"), Type.Literal("subscription")]),
});
export type UsageAggregate = Static<typeof UsageAggregateSchema>;

export const ContextUsageSchema = StrictObject({
	inputTokens: NonNegativeIntegerSchema,
	contextWindow: Type.Integer({ minimum: 1 }),
	usedPercentage: Type.Number({ minimum: 0, maximum: 100 }),
});

export const InstructionProfileSummarySchema = StrictObject({
	id: IdSchema,
	source: Type.Union([Type.Literal("text"), Type.Literal("file")]),
	contentHash: IdSchema,
});

export const CompactionPolicySchema = StrictObject({
	enabled: Type.Boolean(),
	contextWindow: Type.Integer({ minimum: 1 }),
	reserveTokens: NonNegativeIntegerSchema,
	keepRecentTokens: NonNegativeIntegerSchema,
	triggerTokens: NonNegativeIntegerSchema,
	source: Type.Union([Type.Literal("global"), Type.Literal("model"), Type.Literal("mixed")]),
});

export const DiagnosticsSnapshotSchema = StrictObject({
	capture: Type.Union([Type.Literal("metadata"), Type.Literal("encrypted")]),
	degraded: Type.Boolean(),
	lastCriticalEventSeq: NonNegativeIntegerSchema,
});

export const PersistenceSnapshotSchema = StrictObject({
	schemaVersion: NonNegativeIntegerSchema,
	recoveryState: Type.Union([
		Type.Literal("clean"),
		Type.Literal("recovered"),
		Type.Literal("needsResolution"),
		Type.Literal("degraded"),
	]),
});

export const SessionNameSourceSchema = Type.Union([
	Type.Literal("explicit"),
	Type.Literal("generated"),
	Type.Literal("derived"),
]);

export const SessionSnapshotV2Schema = StrictObject({
	id: IdSchema,
	name: Type.Optional(BoundedStringSchema),
	nameSource: Type.Optional(SessionNameSourceSchema),
	nameRevision: NonNegativeIntegerSchema,
	revision: NonNegativeIntegerSchema,
	eventSeq: NonNegativeIntegerSchema,
	phase: SessionPhaseV2Schema,
	activeOperation: Type.Optional(OperationSummarySchema),
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	transcript: Type.Array(TranscriptItemSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	queues: QueueSnapshotSchema,
	plan: Type.Optional(PlanSnapshotSchema),
	goal: Type.Optional(GoalSnapshotSchema),
	agents: Type.Array(AgentSummarySchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	usage: UsageAggregateSchema,
	context: ContextUsageSchema,
	instructionProfile: Type.Optional(InstructionProfileSummarySchema),
	compactionPolicy: CompactionPolicySchema,
	pluginSetHash: IdSchema,
	diagnostics: DiagnosticsSnapshotSchema,
	persistence: PersistenceSnapshotSchema,
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
});
export type SessionSnapshotV2 = Static<typeof SessionSnapshotV2Schema>;

export const SessionMetadataV2Schema = StrictObject({
	id: IdSchema,
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	parentSessionId: Type.Optional(IdSchema),
	sessionName: Type.Optional(BoundedStringSchema),
	nameSource: Type.Optional(SessionNameSourceSchema),
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_V2_STRING_LENGTH })),
});
export type SessionMetadataV2 = Static<typeof SessionMetadataV2Schema>;

export const ServerSnapshotV2Schema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
	revision: NonNegativeIntegerSchema,
	eventSeq: NonNegativeIntegerSchema,
	sessions: Type.Array(SessionMetadataV2Schema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	models: Type.Array(ModelMetadataSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
});
export type ServerSnapshotV2 = Static<typeof ServerSnapshotV2Schema>;

export const isOperationSummary = (value: unknown): value is OperationSummary => Check(OperationSummarySchema, value);

export const isOperationRecordV2 = (value: unknown): value is OperationRecordV2 => {
	const record = value as { operationId?: unknown; accepted?: { operationId?: unknown } };
	return Check(OperationRecordV2Schema, value) && record.operationId === record.accepted?.operationId;
};
