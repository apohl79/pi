import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { type JsonValue, ThinkingLevelSchema } from "./schemas.ts";

export const PROTOCOL_V2_VERSION = 2 as const;

export const MAX_V2_STRING_LENGTH = 1_048_576;
export const MAX_V2_ARRAY_ITEMS = 10_000;
export const MAX_V2_JSON_DEPTH = 8;

const BoundedStringSchema = Type.String({ maxLength: MAX_V2_STRING_LENGTH });
const BoundedNonEmptyStringSchema = Type.String({ minLength: 1, maxLength: MAX_V2_STRING_LENGTH });
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

const createBoundedJsonValueSchema = (remainingDepth: number): TSchema => {
	const scalarSchemas: TSchema[] = [Type.Null(), Type.Boolean(), Type.Number(), BoundedStringSchema];
	return remainingDepth === 0
		? Type.Union(scalarSchemas)
		: Type.Union([
				...scalarSchemas,
				...(() => {
				const childSchema: TSchema = createBoundedJsonValueSchema(remainingDepth - 1);
					return [
						Type.Array(childSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
						Type.Record(BoundedStringSchema, childSchema, {
							maxProperties: MAX_V2_ARRAY_ITEMS,
						}),
					];
				})(),
			]);
};

const BoundedJsonValueSchema = createBoundedJsonValueSchema(MAX_V2_JSON_DEPTH);

const BoundedModelRefSchema = StrictObject({ provider: IdSchema, id: IdSchema });
const BoundedModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});
const BoundedModelMetadataSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: BoundedNonEmptyStringSchema,
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { maxItems: MAX_V2_ARRAY_ITEMS }),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: BoundedModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1, maxItems: MAX_V2_ARRAY_ITEMS }),
	authenticated: Type.Boolean(),
});
const BoundedUsageSchema = StrictObject({
	input: NonNegativeIntegerSchema,
	output: NonNegativeIntegerSchema,
	cacheRead: NonNegativeIntegerSchema,
	cacheWrite: NonNegativeIntegerSchema,
	reasoning: Type.Optional(NonNegativeIntegerSchema),
	totalTokens: NonNegativeIntegerSchema,
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});
const BoundedTextContentSchema = StrictObject({ type: Type.Literal("text"), text: BoundedStringSchema });
const BoundedThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: BoundedStringSchema,
	redacted: Type.Optional(Type.Boolean()),
});
const BoundedImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: BoundedStringSchema,
	mimeType: BoundedNonEmptyStringSchema,
});
const BoundedToolCallContentSchema = StrictObject({
	type: Type.Literal("toolCall"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: BoundedJsonValueSchema,
});
const BoundedUserContentSchema = Type.Union([BoundedTextContentSchema, BoundedImageContentSchema]);
const BoundedAssistantContentSchema = Type.Union([
	BoundedTextContentSchema,
	BoundedThinkingContentSchema,
	BoundedToolCallContentSchema,
]);
const BoundedToolContentSchema = Type.Union([BoundedTextContentSchema, BoundedImageContentSchema]);
const BoundedUserTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(BoundedUserContentSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	timestamp: TimestampSchema,
});
const BoundedAssistantTranscriptProperties = {
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(BoundedAssistantContentSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	model: BoundedModelRefSchema,
	responseModel: Type.Optional(BoundedNonEmptyStringSchema),
	usage: Type.Optional(BoundedUsageSchema),
	timestamp: TimestampSchema,
} as const;
const BoundedAssistantTranscriptItemSchema = Type.Union([
	StrictObject({ ...BoundedAssistantTranscriptProperties, status: Type.Literal("streaming") }),
	StrictObject({
		...BoundedAssistantTranscriptProperties,
		status: Type.Literal("complete"),
		stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
	}),
	StrictObject({
		...BoundedAssistantTranscriptProperties,
		status: Type.Literal("error"),
		stopReason: Type.Literal("error"),
		errorMessage: Type.Optional(BoundedNonEmptyStringSchema),
	}),
	StrictObject({
		...BoundedAssistantTranscriptProperties,
		status: Type.Literal("aborted"),
		stopReason: Type.Literal("aborted"),
		errorMessage: Type.Optional(BoundedStringSchema),
	}),
]);
const BoundedToolTranscriptProperties = {
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: BoundedJsonValueSchema,
	content: Type.Array(BoundedToolContentSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
	details: Type.Optional(BoundedJsonValueSchema),
	usage: Type.Optional(BoundedUsageSchema),
	timestamp: TimestampSchema,
} as const;
const BoundedToolTranscriptItemSchema = Type.Union([
	StrictObject({ ...BoundedToolTranscriptProperties, status: Type.Literal("running"), isError: Type.Literal(false) }),
	StrictObject({ ...BoundedToolTranscriptProperties, status: Type.Literal("complete"), isError: Type.Literal(false) }),
	StrictObject({ ...BoundedToolTranscriptProperties, status: Type.Literal("error"), isError: Type.Literal(true) }),
]);
const BoundedTranscriptItemSchema = Type.Union([
	BoundedUserTranscriptItemSchema,
	BoundedAssistantTranscriptItemSchema,
	BoundedToolTranscriptItemSchema,
]);

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
	terminalSeq: Type.Optional(NonNegativeIntegerSchema),
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
	terminalSeq: Type.Optional(NonNegativeIntegerSchema),
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
	model: BoundedModelRefSchema,
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
	model: BoundedModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	transcript: Type.Array(BoundedTranscriptItemSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
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
	models: Type.Array(BoundedModelMetadataSchema, { maxItems: MAX_V2_ARRAY_ITEMS }),
});
export type ServerSnapshotV2 = Static<typeof ServerSnapshotV2Schema>;

const hasValidTerminalSequence = (acceptedSeq: unknown, terminalSeq: unknown): boolean =>
	terminalSeq === undefined ||
	(typeof acceptedSeq === "number" && typeof terminalSeq === "number" && terminalSeq > acceptedSeq);

export const isOperationSummary = (value: unknown): value is OperationSummary => {
	const summary = value as { acceptedSeq?: unknown; terminalSeq?: unknown };
	return Check(OperationSummarySchema, value) && hasValidTerminalSequence(summary.acceptedSeq, summary.terminalSeq);
};

export const isOperationRecordV2 = (value: unknown): value is OperationRecordV2 => {
	const record = value as {
		operationId?: unknown;
		accepted?: { operationId?: unknown; eventSeq?: unknown };
		terminalSeq?: unknown;
	};
	return (
		Check(OperationRecordV2Schema, value) &&
		record.operationId === record.accepted?.operationId &&
		hasValidTerminalSequence(record.accepted?.eventSeq, record.terminalSeq)
	);
};
export const CommandNameV2Schema = Type.Union([
	Type.Literal("session/list"),
	Type.Literal("session/create"),
	Type.Literal("session/attach"),
	Type.Literal("session/detach"),
	Type.Literal("session/read"),
	Type.Literal("session/delete"),
	Type.Literal("session/name/set"),
	Type.Literal("session/name/generate"),
	Type.Literal("session/name/auto/set"),
	Type.Literal("turn/start"),
	Type.Literal("turn/steer"),
	Type.Literal("turn/followUp"),
	Type.Literal("turn/abort"),
	Type.Literal("turn/resume"),
	Type.Literal("turn/rollback"),
	Type.Literal("operation/read"),
	Type.Literal("model/list"),
	Type.Literal("session/model/set"),
	Type.Literal("session/thinking/set"),
	Type.Literal("agent/spawn"),
	Type.Literal("agent/list"),
	Type.Literal("agent/wait"),
	Type.Literal("agent/message"),
	Type.Literal("agent/followUp"),
	Type.Literal("agent/interrupt"),
	Type.Literal("process/start"),
	Type.Literal("process/write"),
	Type.Literal("process/wait"),
	Type.Literal("process/terminate"),
	Type.Literal("process/read"),
	Type.Literal("input/request/read"),
	Type.Literal("input/request/respond"),
	Type.Literal("input/request/cancel"),
	Type.Literal("plan/read"),
	Type.Literal("plan/update"),
	Type.Literal("goal/read"),
	Type.Literal("goal/create"),
	Type.Literal("goal/update"),
	Type.Literal("goal/pause"),
	Type.Literal("goal/resume"),
	Type.Literal("plugin/list"),
	Type.Literal("plugin/read"),
	Type.Literal("plugin/install"),
	Type.Literal("plugin/uninstall"),
	Type.Literal("plugin/enable"),
	Type.Literal("plugin/disable"),
	Type.Literal("marketplace/add"),
	Type.Literal("marketplace/list"),
	Type.Literal("marketplace/upgrade"),
	Type.Literal("marketplace/remove"),
	Type.Literal("app/list"),
	Type.Literal("app/read"),
	Type.Literal("app/auth/start"),
	Type.Literal("blob/put"),
	Type.Literal("blob/read"),
	Type.Literal("blob/stat"),
	Type.Literal("filesystem/complete"),
	Type.Literal("filesystem/reference/resolve"),
	Type.Literal("filesystem/reference/read"),
	Type.Literal("diagnostics/status"),
	Type.Literal("diagnostics/timeline"),
	Type.Literal("diagnostics/export"),
	Type.Literal("diagnostics/verify"),
	Type.Literal("diagnostics/doctor"),
]);
export type CommandNameV2 = Static<typeof CommandNameV2Schema>;

export const CommandV2Schema = StrictObject({
	command: CommandNameV2Schema,
	sessionId: Type.Optional(IdSchema),
	operationId: Type.Optional(IdSchema),
	requestId: Type.Optional(IdSchema),
	payload: Type.Optional(BoundedJsonValueSchema),
});
export type CommandV2 = Static<typeof CommandV2Schema>;

export const EventNameV2Schema = Type.Union([
	Type.Literal("server_snapshot"),
	Type.Literal("session_snapshot"),
	Type.Literal("session_delta"),
	Type.Literal("operation_accepted"),
	Type.Literal("operation_updated"),
	Type.Literal("operation_terminal"),
	Type.Literal("session_phase_changed"),
	Type.Literal("session_name_updated"),
	Type.Literal("turn_started"),
	Type.Literal("item_completed"),
	Type.Literal("tool_started"),
	Type.Literal("tool_completed"),
	Type.Literal("compaction_started"),
	Type.Literal("compaction_completed"),
	Type.Literal("recovery_report"),
	Type.Literal("process_output"),
	Type.Literal("process_terminal"),
	Type.Literal("agent_updated"),
	Type.Literal("agent_message"),
	Type.Literal("plan_updated"),
	Type.Literal("goal_updated"),
	Type.Literal("model_instruction_profile_changed"),
	Type.Literal("model_compaction_policy_changed"),
	Type.Literal("input_request_updated"),
	Type.Literal("usage_updated"),
	Type.Literal("plugin_diagnostic"),
	Type.Literal("connector_auth_changed"),
	Type.Literal("diagnostics_degraded"),
	Type.Literal("store_integrity_changed"),
	Type.Literal("bundle_progress"),
]);
export type EventNameV2 = Static<typeof EventNameV2Schema>;

export const EventEnvelopeV2Schema = StrictObject({
	type: Type.Literal("event"),
	sessionId: IdSchema,
	seq: NonNegativeIntegerSchema,
	revision: NonNegativeIntegerSchema,
	operationId: Type.Optional(IdSchema),
	event: EventNameV2Schema,
	payload: Type.Unsafe<JsonValue>(BoundedJsonValueSchema),
});
export type EventEnvelopeV2 = Static<typeof EventEnvelopeV2Schema>;

export const ClientHelloV2Schema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_V2_VERSION),
	lastEvent: Type.Optional(EventCursorSchema),
});
export type ClientHelloV2 = Static<typeof ClientHelloV2Schema>;

export const ServerHelloV2Schema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_V2_VERSION),
	connectionId: IdSchema,
	snapshot: ServerSnapshotV2Schema,
});
export type ServerHelloV2 = Static<typeof ServerHelloV2Schema>;

export const ServerHelloErrorV2Schema = StrictObject({
	type: Type.Literal("hello_error"),
	error: StrictObject({
		code: IdSchema,
		message: BoundedStringSchema,
		details: Type.Optional(BoundedJsonValueSchema),
	}),
});
export type ServerHelloErrorV2 = Static<typeof ServerHelloErrorV2Schema>;

export const RequestEnvelopeV2Schema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	request: CommandV2Schema,
});
export type RequestEnvelopeV2 = Static<typeof RequestEnvelopeV2Schema>;

export const ResponseEnvelopeV2Schema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		accepted: OperationAcceptedSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: BoundedJsonValueSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: StrictObject({
			code: IdSchema,
			message: BoundedStringSchema,
			details: Type.Optional(BoundedJsonValueSchema),
		}),
	}),
]);
export type ResponseEnvelopeV2 = Static<typeof ResponseEnvelopeV2Schema>;

export const ClientMessageV2Schema = Type.Union([ClientHelloV2Schema, RequestEnvelopeV2Schema]);
export const ServerMessageV2Schema = Type.Union([
	ServerHelloV2Schema,
	ServerHelloErrorV2Schema,
	ResponseEnvelopeV2Schema,
	EventEnvelopeV2Schema,
]);
export type ClientMessageV2 = Static<typeof ClientMessageV2Schema>;
export type ServerMessageV2 = Static<typeof ServerMessageV2Schema>;

export const isClientMessageV2 = (value: unknown): value is ClientMessageV2 => Check(ClientMessageV2Schema, value);
export const isServerMessageV2 = (value: unknown): value is ServerMessageV2 => Check(ServerMessageV2Schema, value);
