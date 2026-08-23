import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import {
	type JsonValue,
	JsonValueSchema,
	ModelMetadataSchema,
	ModelRefSchema,
	ThinkingLevelSchema,
	TranscriptItemSchema,
} from "./schemas.ts";

export const PROTOCOL_V2_VERSION = 2 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const CompactionPolicySchema = StrictObject({
	enabled: Type.Boolean(),
	contextWindow: Type.Integer({ minimum: 1 }),
	reserveTokens: NonNegativeIntegerSchema,
	keepRecentTokens: NonNegativeIntegerSchema,
	triggerTokens: NonNegativeIntegerSchema,
	source: Type.Union([Type.Literal("global"), Type.Literal("model"), Type.Literal("mixed")]),
});
export type CompactionPolicy = Static<typeof CompactionPolicySchema>;

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

export const OperationSummarySchema = StrictObject({
	operationId: IdSchema,
	kind: Type.String({ minLength: 1 }),
	state: OperationStateSchema,
	acceptedSeq: NonNegativeIntegerSchema,
	terminalSeq: Type.Optional(NonNegativeIntegerSchema),
	compactionPolicy: Type.Optional(CompactionPolicySchema),
});
export type OperationSummary = Static<typeof OperationSummarySchema>;

export const OperationAcceptedSchema = StrictObject({
	operationId: IdSchema,
	sessionRevision: NonNegativeIntegerSchema,
	eventSeq: NonNegativeIntegerSchema,
	compactionPolicy: Type.Optional(CompactionPolicySchema),
});
export type OperationAccepted = Static<typeof OperationAcceptedSchema>;

export const OperationRecordV2Schema = StrictObject({
	operationId: IdSchema,
	sessionId: IdSchema,
	state: OperationStateSchema,
	accepted: OperationAcceptedSchema,
	terminalSeq: Type.Optional(NonNegativeIntegerSchema),
	error: Type.Optional(Type.String()),
});
export type OperationRecordV2 = Static<typeof OperationRecordV2Schema>;

export const EventCursorSchema = StrictObject({
	sessionId: IdSchema,
	eventSeq: NonNegativeIntegerSchema,
});
export type EventCursor = Static<typeof EventCursorSchema>;

export const PromptContentSchema = Type.Union([
	StrictObject({ type: Type.Literal("text"), text: Type.String() }),
	StrictObject({ type: Type.Literal("image"), digest: IdSchema, mimeType: Type.String({ minLength: 1 }) }),
	StrictObject({ type: Type.Literal("blob"), digest: IdSchema, mimeType: Type.String({ minLength: 1 }) }),
	StrictObject({ type: Type.Literal("mention"), name: IdSchema, path: IdSchema }),
]);
export type PromptContent = Static<typeof PromptContentSchema>;

export const QueuedInputSchema = StrictObject({
	id: IdSchema,
	content: Type.Array(PromptContentSchema, { minItems: 1 }),
	createdAt: TimestampSchema,
});

export const QueueSnapshotSchema = StrictObject({
	steer: Type.Array(QueuedInputSchema),
	followUp: Type.Array(QueuedInputSchema),
	pendingInputRequestId: Type.Optional(IdSchema),
});

export const PlanItemSchema = StrictObject({
	step: Type.String({ minLength: 1 }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
});
export type PlanItem = Static<typeof PlanItemSchema>;

export const PlanSnapshotSchema = StrictObject({
	version: NonNegativeIntegerSchema,
	items: Type.Array(PlanItemSchema),
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
	objective: Type.String({ minLength: 1 }),
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
	taskName: Type.String({ minLength: 1 }),
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
	imageUnits: Type.Optional(NonNegativeIntegerSchema),
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
export type InstructionProfileSummary = Static<typeof InstructionProfileSummarySchema>;

export const DiagnosticsSnapshotSchema = StrictObject({
	capture: Type.Union([Type.Literal("metadata"), Type.Literal("encrypted")]),
	degraded: Type.Boolean(),
	lastCriticalEventSeq: NonNegativeIntegerSchema,
});
export type DiagnosticsSnapshot = Static<typeof DiagnosticsSnapshotSchema>;

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
	name: Type.Optional(Type.String()),
	nameSource: Type.Optional(SessionNameSourceSchema),
	nameRevision: NonNegativeIntegerSchema,
	revision: NonNegativeIntegerSchema,
	eventSeq: NonNegativeIntegerSchema,
	phase: SessionPhaseV2Schema,
	activeOperation: Type.Optional(OperationSummarySchema),
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	transcript: Type.Array(TranscriptItemSchema),
	queues: QueueSnapshotSchema,
	steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
	followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
	autoRetryEnabled: Type.Optional(Type.Boolean()),
	plan: Type.Optional(PlanSnapshotSchema),
	goal: Type.Optional(GoalSnapshotSchema),
	agents: Type.Array(AgentSummarySchema),
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
	sessionName: Type.Optional(Type.String()),
	nameSource: Type.Optional(SessionNameSourceSchema),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});
export type SessionMetadataV2 = Static<typeof SessionMetadataV2Schema>;

export const ServerSnapshotV2Schema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
	revision: NonNegativeIntegerSchema,
	eventSeq: NonNegativeIntegerSchema,
	sessions: Type.Array(SessionMetadataV2Schema),
	models: Type.Array(ModelMetadataSchema),
});
export type ServerSnapshotV2 = Static<typeof ServerSnapshotV2Schema>;

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
	Type.Literal("turn/compact"),
	Type.Literal("operation/read"),
	Type.Literal("model/list"),
	Type.Literal("session/model/set"),
	Type.Literal("session/thinking/set"),
	Type.Literal("session/steering-mode/set"),
	Type.Literal("session/follow-up-mode/set"),
	Type.Literal("session/compaction/set"),
	Type.Literal("session/retry/set"),
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
	Type.Literal("plan/clear"),
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
	Type.Literal("app/auth/complete"),
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
	Type.Literal("usage/read"),
	Type.Literal("web"),
	Type.Literal("image/view"),
	Type.Literal("image/generate"),
]);
export type CommandNameV2 = Static<typeof CommandNameV2Schema>;

export const CommandV2Schema = StrictObject({
	command: CommandNameV2Schema,
	sessionId: Type.Optional(IdSchema),
	operationId: Type.Optional(IdSchema),
	requestId: Type.Optional(IdSchema),
	payload: Type.Optional(JsonValueSchema),
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
	payload: Type.Unsafe<JsonValue>(JsonValueSchema),
});
export type EventEnvelopeV2 = Static<typeof EventEnvelopeV2Schema>;

export const ClientDiagnosticManifestV2Schema = StrictObject({
	runtime: Type.String({ minLength: 1 }),
	platform: Type.String({ minLength: 1 }),
	arch: Type.String({ minLength: 1 }),
	buildVersion: Type.Optional(Type.String({ minLength: 1 })),
	forkCommit: Type.Optional(Type.String({ minLength: 1 })),
	upstreamBaseCommit: Type.Optional(Type.String({ minLength: 1 })),
	configHash: Type.Optional(Type.String({ minLength: 1 })),
});
export type ClientDiagnosticManifestV2 = Static<typeof ClientDiagnosticManifestV2Schema>;

export const ClientHelloV2Schema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_V2_VERSION),
	lastEvent: Type.Optional(EventCursorSchema),
	diagnostics: Type.Optional(
		StrictObject({
			manifest: ClientDiagnosticManifestV2Schema,
			afterSeq: Type.Optional(NonNegativeIntegerSchema),
		}),
	),
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
	error: StrictObject({ code: IdSchema, message: Type.String(), details: Type.Optional(JsonValueSchema) }),
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
		result: JsonValueSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: StrictObject({ code: IdSchema, message: Type.String(), details: Type.Optional(JsonValueSchema) }),
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
