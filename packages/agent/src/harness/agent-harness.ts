import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { runAgentLoop } from "../agent-loop.ts";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import {
	type CompactionSettings,
	compact,
	prepareCompaction,
	validateCompactionSettings,
} from "./compaction/compaction.ts";
import { Result as ResultValue, TaggedError } from "./result.ts";
import { buildSessionContext } from "./session/context.ts";
import { MAX_DURABLE_COMPACTION_TEXT_LENGTH } from "./session/types.ts";
import type {
	AbortRequestedRecord,
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	JsonValue,
	NewRecord,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueCancelledRecord,
	QueueEnqueuedRecord,
	Session,
	SessionTree,
	UsageRecord,
} from "./session/index.ts";
import type { TelemetryContext } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessNotImplemented extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

function durableClone<T>(value: T): T {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Durable payload cannot be undefined");
	return JSON.parse(encoded) as T;
}

function sanitizeErrorMessage(
	value: unknown,
	fallback: string,
	maxLength = 512,
	preserveWhitespace = false,
): string {
	const raw = value instanceof Error ? value.message : String(value);
	const sanitized = raw
		// Error payloads commonly echo credentials as an Authorization header or
		// JSON. Stop at JSON/string delimiters so the useful surrounding error is
		// retained without carrying the secret into durable history.
		.replace(/\bBearer\s+[^\s"'`,;}\]]+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
		.replace(/\b(?:AIza|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
		.replace(
			/([\"']?(?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization|credential)[\"']?)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)/gi,
			"$1=[redacted]",
		)
		.replace(/[\u0000-\u001f\u007f]/g, (character) => (preserveWhitespace && /[\r\n\t]/.test(character) ? character : " "))
		.replace(preserveWhitespace ? /[ \t]+/g : /\s+/g, preserveWhitespace ? " " : " ")
		.trim()
		.slice(0, maxLength);
	return sanitized || fallback;
}

function sanitizeErrorDetails(value: unknown, depth = 0): unknown {
	if (depth >= 6) return "[redacted]";
	if (typeof value === "string") return sanitizeErrorMessage(value, "");
	if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeErrorDetails(item, depth + 1));
	if (value !== null && typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).slice(0, 32)) {
			if (/api[_ -]?key|access[_ -]?token|secret|password|authorization|credential|^token$/i.test(key)) {
				sanitized[key] = "[redacted]";
			} else {
				sanitized[key] = sanitizeErrorDetails(item, depth + 1);
			}
		}
		return sanitized;
	}
	return value;
}

function sanitizeTranscriptMessage(message: AgentMessage): AgentMessage {
	if (message.role === "assistant") {
		const content =
			(message.stopReason === "error" || message.stopReason === "aborted")
				? message.content.map((part) => {
						if (part.type === "text") return { ...part, text: sanitizeErrorMessage(part.text, "") };
						if (part.type === "thinking") return { ...part, thinking: sanitizeErrorMessage(part.thinking, "") };
						if (part.type === "toolCall") {
							return { ...part, arguments: sanitizeErrorDetails(part.arguments) as Record<string, unknown> };
						}
						return part;
				  })
				: message.content;
		return {
			...message,
			content,
			...(message.errorMessage === undefined
				? {}
				: { errorMessage: sanitizeErrorMessage(message.errorMessage, "Provider request failed") }),
		};
	}
	if (message.role === "toolResult" && message.isError) {
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "text" ? { ...part, text: sanitizeErrorMessage(part.text, "") } : part,
			),
			details: sanitizeErrorDetails(message.details),
		};
	}
	return message;
}

function sanitizeCompactionValue(value: unknown, depth = 0): unknown {
	if (depth >= 12) return "[redacted]";
	if (typeof value === "string") {
		return sanitizeErrorMessage(value, "", MAX_DURABLE_COMPACTION_TEXT_LENGTH, true);
	}
	if (Array.isArray(value)) return value.map((item) => sanitizeCompactionValue(item, depth + 1));
	if (value !== null && typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (/api[_ -]?key|token|secret|password|authorization|credential/i.test(key)) {
				sanitized[key] = "[redacted]";
			} else if (key === "details") {
				sanitized[key] = sanitizeErrorDetails(item);
			} else {
				sanitized[key] = sanitizeCompactionValue(item, depth + 1);
			}
		}
		return sanitized;
	}
	return value;
}

function sanitizeCompactionMessage(message: AgentMessage): AgentMessage {
	return sanitizeCompactionValue(sanitizeTranscriptMessage(message)) as AgentMessage;
}

export interface OperationError {
	code: string;
	message: string;
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | MissingIdentities | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | MissingIdentities | Closed;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
export type CancelQueuedRejected = UnknownQueueItem | Closed;
export type AbortRejected = NoActiveOperation | Closed;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

class UnavailableRegistry implements Hooks, Events {
	private readonly operation: string;
	private readonly isClosed: () => boolean;

	constructor(operation: string, isClosed: () => boolean) {
		this.operation = operation;
		this.isClosed = isClosed;
	}

	on(
		_name: HookName | string,
		_handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		throw this.isClosed() ? new HarnessClosed() : new HarnessNotImplemented(this.operation);
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	context?: TelemetryContext;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentHarness implements AgentLane {
	readonly name = "main";
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly models: Models;
	private readonly systemPromptSource: AgentHarnessOptions["systemPrompt"];
	private readonly toProviderMessages: AgentHarnessOptions["toProviderMessages"];
	private model: Model<Api>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private closed = false;
	private activeOperation:
		| {
				id: string;
				kind: "run" | "compaction";
				controller: AbortController;
				done: Promise<void>;
				resolveDone: () => void;
		  }
		| undefined;
	private readonly finishedOperations = new Set<string>();
	private readonly finishingOperations = new Map<string, Promise<void>>();
	private missingModels: string[] = [];
	private missingTools: string[] = [];
	private static readonly finishedOperationCacheLimit = 1024;

	private constructor(options: AgentHarnessOptions) {
		this.durableSession = options.session;
		this.models = options.models;
		this.systemPromptSource = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages;
		this.session = options.session;
		this.hooks = new UnavailableRegistry("hooks.on", () => this.closed);
		this.events = new UnavailableRegistry("events.on", () => this.closed);
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = validateCompactionSettings(options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const harness = new AgentHarness(options);
		const branchEntries = await options.session.findEntriesOnBranch({ order: "newestFirst" });
		const persistedModel = branchEntries.find((entry) => entry.type === "model_change");
		const missingModels: string[] = [];
		if (persistedModel?.type === "model_change") {
			const model = options.models.getModel(persistedModel.provider, persistedModel.modelId);
			if (model) harness.model = model;
			else missingModels.push(`${persistedModel.provider}/${persistedModel.modelId}`);
		}
		harness.missingModels = missingModels;
		const persistedThinking = branchEntries.find((entry) => entry.type === "thinking_level_change");
		if (persistedThinking?.type === "thinking_level_change") {
			const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			if (levels.includes(persistedThinking.thinkingLevel as ThinkingLevel)) {
				harness.thinkingLevel = persistedThinking.thinkingLevel as ThinkingLevel;
			}
		}
		const persistedTools = branchEntries.find((entry) => entry.type === "active_tools_change");
		if (persistedTools?.type === "active_tools_change") {
			harness.activeToolNames = [...persistedTools.activeToolNames];
			const availableTools = new Set(harness.tools.map((tool) => tool.name));
			harness.missingTools = persistedTools.activeToolNames.filter((name) => !availableTools.has(name));
		}
		const lanes = await options.session.getLanes();
		const suspended: SuspendedOperation[] = [];
		for (const lane of lanes) {
			const operations = await options.session.findOpenOperations(lane.lane);
			for (const operation of operations) {
				const intent = operation.intent;
				suspended.push({
					lane: operation.lane,
					kind: intent.kind,
					id: operation.id,
					startedAt: operation.timestamp,
					reason: "crash",
					prompt: intent.kind === "run" ? structuredClone(intent.originalPrompt) : undefined,
					missing: { tools: [...harness.missingTools], models: [...missingModels] },
				});
			}
		}
		return { harness, suspended };
	}

	private unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	async getLeafId(): Promise<string | null> {
		return this.durableSession.getLeafId();
	}

	async prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	async prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		if (this.missingModels.length > 0 || this.missingTools.length > 0)
			return ResultValue.err(
				new MissingIdentities({
					lane: "main",
					tools: [...this.missingTools],
					models: [...this.missingModels],
					message: this.missingModels.length > 0 ? "Persisted model is unavailable" : "Persisted tools are unavailable",
				}),
			);
		const localRunId = this.durableSession.idGenerator.next();
		const controller = new AbortController();
		if (this.activeOperation) {
			return ResultValue.err(
				new LaneBusy({
					lane: "main",
					operationId: this.activeOperation.id,
					operationKind: this.activeOperation.kind,
					message: "Lane is busy",
				}),
			);
		}
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		this.activeOperation = { id: localRunId, kind: "run", controller, done, resolveDone };
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			resolveDone();
			if (this.activeOperation?.id === localRunId) this.activeOperation = undefined;
		};
		let open: OperationStartedRecord[];
		try {
			open = await this.durableSession.findOpenOperations("main", { limit: 1 });
		} catch (error) {
			release();
			throw error;
		}
		if (open.length > 0) {
			release();
			return ResultValue.err(
				new LaneBusy({
					lane: "main",
					operationId: open[0]!.id,
					operationKind: open[0]!.intent.kind,
					message: "Lane is busy",
				}),
			);
		}
		let prompts: AgentMessage[];
		try {
			prompts = this.normalizePromptInput(input, images);
		} catch (error) {
			release();
			throw error;
		}
		const runId = localRunId;
		let started: NewRecord<OperationStartedRecord>;
		try {
			started = {
				type: "operation_started",
				id: runId,
				lane: "main",
				sourceLeafId: await this.durableSession.getLeafId(),
				intent: {
					kind: "run",
					originalPrompt: durableClone(prompts),
					initialMessages: prompts.map((message) => ({
						type: "message",
						id: this.durableSession.idGenerator.next(),
						message: durableClone(message),
					})),
				},
			};
		} catch (error) {
			release();
			throw error;
		}
		try {
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			await this.durableSession.appendRecord(started);
		} catch (error) {
			const raced = await this.durableSession.findOpenOperations("main", { limit: 1 }).catch(() => []);
			if (raced.length > 0 && raced[0]!.id === runId) {
				// Some remote stores can commit before reporting a transport error.
				// Continue the operation when our own start is durably visible.
			} else if (raced.length > 0) {
				release();
				return ResultValue.err(
					new LaneBusy({
						lane: "main",
						operationId: raced[0]!.id,
						operationKind: raced[0]!.intent.kind,
						message: "Lane is busy",
					}),
				);
			} else {
				release();
				throw error;
			}
		}
		try {
			const entries = await this.durableSession.findEntriesOnBranch({ order: "oldestFirst" });
			const persisted = buildSessionContext(entries);
			const systemPrompt =
				typeof this.systemPromptSource === "function"
					? await this.systemPromptSource()
					: (this.systemPromptSource ?? "");
			const activeTools = this.tools.filter((tool) => this.activeToolNames.includes(tool.name));
			const newMessages = await runAgentLoop(
				prompts,
				{ systemPrompt, messages: persisted.messages, tools: activeTools },
				{
					...this.streamOptions,
					model: this.model,
					reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
					convertToLlm:
						this.toProviderMessages ??
						((messages) =>
							messages.filter(
								(message): message is Message =>
									message.role === "user" || message.role === "assistant" || message.role === "toolResult",
							)),
				},
				async () => {},
					controller.signal,
				this.models.streamSimple.bind(this.models),
			);
			let finalEntryId: string | undefined;
			const transcriptMessages = newMessages.map(sanitizeTranscriptMessage);
			for (const message of transcriptMessages) {
				finalEntryId = await this.durableSession.appendMessage(durableClone(message));
			}
			const finalMessage = transcriptMessages.at(-1);
			if (!finalEntryId || !finalMessage || finalMessage.role !== "assistant")
				throw new Error("Agent loop produced no assistant message");
			if (finalMessage.stopReason === "aborted") {
				await this.finishOperation(runId, "aborted", { code: "aborted", message: "Run aborted" });
				return ResultValue.ok({ runId, kind: "aborted", leafId: (await this.durableSession.getLeafId()) ?? "", finalEntryId, finalMessage });
			}
			if (finalMessage.stopReason === "error") {
				const error = { code: "run_error", message: sanitizeErrorMessage(finalMessage.errorMessage, "Run failed") };
				await this.finishOperation(runId, "failed", error);
				return ResultValue.ok({ runId, kind: "failed", leafId: (await this.durableSession.getLeafId()) ?? "", error, finalEntryId, finalMessage });
			}
			await this.finishOperation(runId, "completed");
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			return ResultValue.ok({
				runId,
				kind: "completed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				finalEntryId,
				finalMessage,
			});
		} catch (error) {
			if (this.closed || controller.signal.aborted) {
				await this.finishOperation(runId, "aborted", { code: "aborted", message: "Run aborted" });
				throw error instanceof HarnessClosed ? error : new HarnessClosed();
			}
			const message = sanitizeErrorMessage(error, "Run failed");
			await this.finishOperation(runId, "failed", { code: "run_failed", message });
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			return ResultValue.ok({
				kind: "failed",
				runId,
				leafId: (await this.durableSession.getLeafId()) ?? "",
				error: { code: "run_failed", message },
			});
		} finally {
			release();
		}
	}

	private async finishOperation(
		runId: string,
		outcome: OperationFinishedRecord["outcome"],
		error?: OperationFinishedRecord["error"],
	): Promise<void> {
		if (this.finishedOperations.has(runId)) return;
		const existingAttempt = this.finishingOperations.get(runId);
		if (existingAttempt) return existingAttempt;
		const attempt = (async () => {
			const existing = await this.durableSession.findRecords({ type: "operation_finished", runId, limit: 1 });
			if (existing.length > 0) {
				this.rememberFinishedOperation(runId);
				return;
			}
			// Reuse one terminal id for every append/reconciliation attempt. If the
			// append committed before its transport response, retrying with a fresh id
			// would create a duplicate terminal record when confirmation is delayed or
			// temporarily unavailable.
			const terminalId = this.durableSession.idGenerator.next();
			let lastError: unknown;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					await this.durableSession.appendRecord({
						type: "operation_finished",
						id: terminalId,
						lane: "main",
						runId,
						outcome,
						...(error ? { error } : {}),
					});
					lastError = undefined;
					break;
				} catch (candidate) {
					lastError = candidate;
					// A remote store may commit the record and then report a transport
					// failure. Confirm durable state before retrying, otherwise a retry
					// creates a duplicate terminal record (or fails on duplicate IDs).
					const committed = await this.durableSession
						.findRecords({ type: "operation_finished", runId, limit: 1 })
						.catch(() => []);
					if (committed.length > 0) {
						lastError = undefined;
						break;
					}
					if (attempt === 2) throw candidate;
					await Promise.resolve();
				}
			}
			if (lastError !== undefined) throw lastError;
			this.rememberFinishedOperation(runId);
		})();
		this.finishingOperations.set(runId, attempt);
		try {
			await attempt;
		} finally {
			if (this.finishingOperations.get(runId) === attempt) this.finishingOperations.delete(runId);
		}
	}

	private rememberFinishedOperation(runId: string): void {
		this.finishedOperations.add(runId);
		if (this.finishedOperations.size <= AgentHarness.finishedOperationCacheLimit) return;
		const oldest = this.finishedOperations.values().next().value as string | undefined;
		if (oldest !== undefined) this.finishedOperations.delete(oldest);
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) return structuredClone(input);
		if (typeof input !== "string") return [structuredClone(input)];
		return [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }];
	}
	async skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		return this.unavailable("skill");
	}
	async promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		return this.unavailable("promptFromTemplate");
	}
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		if (_options?.customInstructions !== undefined) {
			if (typeof _options.customInstructions !== "string") {
				return ResultValue.err(
					new InvalidMessage({
						lane: "main",
						reason: "invalid_custom_instructions",
						message: "Compaction customInstructions must be a string",
					}),
				);
			}
			if (_options.customInstructions.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH) {
				return ResultValue.err(new InvalidMessage({
					lane: "main",
					reason: "custom_instructions_too_large",
					message: `Compaction customInstructions exceeds ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}));
			}
		}
		if (this.missingModels.length > 0 || this.missingTools.length > 0)
			return ResultValue.err(
				new MissingIdentities({
					lane: "main",
					tools: [...this.missingTools],
					models: [...this.missingModels],
					message: this.missingModels.length > 0 ? "Persisted model is unavailable" : "Persisted tools are unavailable",
				}),
			);
		const localRunId = this.durableSession.idGenerator.next();
		const controller = new AbortController();
		if (this.activeOperation) {
			return ResultValue.err(
				new LaneBusy({
					lane: "main",
					operationId: this.activeOperation.id,
					operationKind: this.activeOperation.kind,
					message: "Lane is busy",
				}),
			);
		}
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		this.activeOperation = { id: localRunId, kind: "compaction", controller, done, resolveDone };
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			resolveDone();
			if (this.activeOperation?.id === localRunId) this.activeOperation = undefined;
		};
		let open: OperationStartedRecord[];
		try {
			open = await this.durableSession.findOpenOperations("main", { limit: 1 });
		} catch (error) {
			release();
			throw error;
		}
		if (open.length > 0) {
			release();
			return ResultValue.err(
				new LaneBusy({
					lane: "main",
					operationId: open[0]!.id,
					operationKind: open[0]!.intent.kind,
					message: "Lane is busy",
				}),
			);
		}
		let preparation: ReturnType<typeof prepareCompaction>;
		try {
			const entries = await this.durableSession.findEntriesOnBranch({ order: "oldestFirst" });
			preparation = prepareCompaction(entries, this.compactionSettings);
		} catch (error) {
			release();
			throw error;
		}
		if (!preparation.ok) {
			release();
			return ResultValue.ok({
				runId: this.durableSession.idGenerator.next(),
				kind: "failed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				error: { code: preparation.error.code, message: preparation.error.message },
			});
		}
		if (!preparation.value) {
			release();
			return ResultValue.err(new NothingToCompact({ lane: "main", message: "Nothing to compact" }));
		}
		const runId = localRunId;
		let resultEntryId: string;
		try {
			resultEntryId = this.durableSession.idGenerator.next();
		} catch (error) {
			release();
			throw error;
		}
		let startedPersisted = false;
		try {
			try {
				await this.durableSession.appendRecord({
					type: "operation_started",
					id: runId,
					lane: "main",
					sourceLeafId: await this.durableSession.getLeafId(),
					intent: { kind: "compaction", resultEntryId, customInstructions: _options?.customInstructions },
				});
			} catch (error) {
				const raced = await this.durableSession.findOpenOperations("main", { limit: 1 }).catch(() => []);
				if (raced.length > 0 && raced[0]!.id !== runId) {
					return ResultValue.err(
						new LaneBusy({
							lane: "main",
							operationId: raced[0]!.id,
							operationKind: raced[0]!.intent.kind,
							message: "Lane is busy",
						}),
					);
				}
				if (raced.length === 0) throw error;
				// The append may have committed before the backend reported an error.
				// Continue the operation when our own start is durably visible.
			}
			startedPersisted = true;
			const result = await compact(
				preparation.value,
				this.models,
				this.model,
				_options?.customInstructions,
				controller.signal,
				this.thinkingLevel,
				this.retryPolicy,
			);
			if (!result.ok) {
				await this.finishOperation(
					runId,
					result.error.code === "aborted" ? "aborted" : "failed",
					{ code: result.error.code, message: sanitizeErrorMessage(result.error.message, "Compaction failed") },
				);
				if (this.closed || controller.signal.aborted) throw new HarnessClosed();
				if (result.error.code === "aborted") {
					return ResultValue.ok({
						runId,
						kind: "aborted",
						leafId: (await this.durableSession.getLeafId()) ?? "",
					});
				}
				return ResultValue.ok({
					runId,
					kind: "failed",
					leafId: (await this.durableSession.getLeafId()) ?? "",
					error: { code: result.error.code, message: sanitizeErrorMessage(result.error.message, "Compaction failed") },
				});
			}
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			const entry = await this.durableSession.appendEntry<CompactionEntry>(
				{
					type: "compaction",
					id: resultEntryId,
					summary: sanitizeErrorMessage(
						result.value.summary,
						"Compaction summary unavailable",
						MAX_DURABLE_COMPACTION_TEXT_LENGTH,
						true,
					),
					retainedTail: durableClone(result.value.retainedTail.map(sanitizeCompactionMessage)),
					tokensBefore: result.value.tokensBefore,
					...(result.value.details === undefined
						? {}
						: { details: durableClone(sanitizeErrorDetails(result.value.details)) }),
					...(result.value.usage === undefined ? {} : { usage: durableClone(result.value.usage) }),
				},
				"main",
			);
			await this.finishOperation(runId, "completed");
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			return ResultValue.ok({
				runId,
				kind: "completed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				entry,
			});
		} catch (error) {
			if (!startedPersisted) {
				release();
				throw error;
			}
			if (this.closed || controller.signal.aborted) {
				await this.finishOperation(runId, "aborted", { code: "aborted", message: "Compaction aborted" });
				throw error instanceof HarnessClosed ? error : new HarnessClosed();
			}
			const message = sanitizeErrorMessage(error, "Compaction failed");
			await this.finishOperation(runId, "failed", { code: "compaction_failed", message });
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			return ResultValue.ok({
				runId,
				kind: "failed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				error: { code: "compaction_failed", message },
			});
		} finally {
			release();
		}
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unavailable("navigateTree");
	}
	async resume(): Promise<ResumeResult> {
		return this.unavailable("resume");
	}
	async abort(): Promise<AbortResult> {
		return this.unavailable("abort");
	}
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("steer");
	}
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("followUp");
	}
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("nextRun");
	}
	async cancelQueued(_entryId: string): Promise<CancelQueuedResult> {
		return this.unavailable("cancelQueued");
	}
	async recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.unavailable("recordUsage");
	}
	async waitForIdle(): Promise<void> {
		return this.unavailable("waitForIdle");
	}
	async runWhenIdle(_callback: () => void | Promise<void>): Promise<void> {
		return this.unavailable("runWhenIdle");
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("peekAction");
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("executeAction");
	}
	async runToCompletion(): Promise<void> {
		return this.unavailable("runToCompletion");
	}
	async getModel(): Promise<Model<Api>> {
		return this.model;
	}
	private async appendConfigurationEntry<TEntry extends Entry>(
		entry: ProvisionedEntry<TEntry>,
		apply: (committed: TEntry) => void,
	): Promise<void> {
		let committed: TEntry;
		try {
			committed = await this.durableSession.appendEntry(entry, "main");
		} catch (error) {
			// The backend may have committed the append before reporting a transport
			// failure. Reconcile the in-memory view before propagating that failure so
			// callers do not observe durable state and stale harness configuration.
			try {
				const recovered = await this.durableSession.getEntry(entry.id);
				if (recovered?.type === entry.type) apply(recovered as TEntry);
			} catch {
				// Preserve the original append error when recovery is unavailable.
			}
			throw error;
		}
		apply(committed);
	}
	async setModel(model: Model<Api>): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		await this.appendConfigurationEntry(
			{ type: "model_change", id: this.durableSession.idGenerator.next(), provider: model.provider, modelId: model.id },
			(committed) => {
				if (committed.type !== "model_change") return;
				const committedModel = this.models.getModel(committed.provider, committed.modelId);
				if (committedModel) {
					this.model = committedModel;
					this.missingModels = [];
				} else if (committed.provider === model.provider && committed.modelId === model.id) {
					this.model = model;
					this.missingModels = [];
				} else {
					this.missingModels = [`${committed.provider}/${committed.modelId}`];
				}
			},
		);
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		await this.appendConfigurationEntry(
			{ type: "thinking_level_change", id: this.durableSession.idGenerator.next(), thinkingLevel: level },
			(committed) => {
				if (committed.type !== "thinking_level_change") return;
				this.thinkingLevel = committed.thinkingLevel as ThinkingLevel;
			},
		);
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		const activeToolNames = [...names];
		await this.appendConfigurationEntry(
			{ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames },
			(committed) => {
				if (committed.type !== "active_tools_change") return;
				this.activeToolNames = [...committed.activeToolNames];
				const availableTools = new Set(this.tools.map((tool) => tool.name));
				this.missingTools = this.activeToolNames.filter((name) => !availableTools.has(name));
			},
		);
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.unavailable("watch");
	}

	async lane(_name: string): Promise<AgentLane | undefined> {
		return this.unavailable("lane");
	}
	async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
		return this.unavailable("createLane");
	}
	async lanes(): Promise<LaneInfo[]> {
		return this.unavailable("lanes");
	}
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		const nextTools = [...tools];
		const nextActiveNames = [...(activeNames ?? tools.map((tool) => tool.name))];
		await this.appendConfigurationEntry(
			{ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames: nextActiveNames },
			(committed) => {
				if (committed.type !== "active_tools_change") return;
				this.tools = nextTools;
				this.activeToolNames = [...committed.activeToolNames];
				const availableTools = new Set(nextTools.map((tool) => tool.name));
				this.missingTools = this.activeToolNames.filter((name) => !availableTools.has(name));
			},
		);
	}
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = { ...options };
	}
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = validateCompactionSettings(settings);
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		return this.unavailable("watchSession");
	}
	async close(): Promise<void> {
		this.closed = true;
		const active = this.activeOperation;
		active?.controller.abort();
		if (active) {
			await Promise.race([
				active.done,
				new Promise<void>((resolve) => {
					setTimeout(resolve, 5_000);
				}),
			]);
		}
	}
}
