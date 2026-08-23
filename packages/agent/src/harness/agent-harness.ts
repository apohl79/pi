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
	type BranchSummaryResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
} from "./compaction/branch-summarization.ts";
import {
	type CompactionSettings,
	compact,
	prepareCompaction,
	validateCompactionSettings,
} from "./compaction/compaction.ts";
import { HarnessEventBus } from "./events.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
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
import { formatSkillInvocation } from "./skills.ts";
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
export class InvalidRollback extends TaggedError("InvalidRollback")<{ lane: string; message: string }> {}
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
export type RollbackResult = ResultValue<
	{ targetId: string | null; removedTurns: number },
	InvalidRollback | LaneBusy | Closed
>;
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
	/** Deferred writes are not exposed by this harness snapshot implementation. */
	pendingWrites?: { id: string; entry: ProvisionedEntry }[];
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

class LifecycleRegistry implements Hooks, Events {
	private readonly hooks = new Map<HookName, Array<{ id: string; handler: (event: unknown) => unknown | Promise<unknown> }>>();
	private readonly events = new Map<string, Set<(event: unknown) => void | Promise<void>>>();
	private nextId = 0;

	constructor(private readonly isClosed: () => boolean) {}

	on(
		name: HookName | string,
		handler: (event: unknown) => unknown | Promise<unknown>,
		options?: { id?: string },
	): () => void {
		if (this.isClosed()) throw new HarnessClosed();
		const hookName = name as HookName;
		const id = options?.id ?? `hook-${++this.nextId}`;
		const handlers = this.hooks.get(hookName) ?? [];
		const registration = { id, handler };
		if (handlers.some((candidate) => candidate.id === id)) throw new Error(`Duplicate lifecycle hook id: ${id}`);
		handlers.push(registration);
		this.hooks.set(hookName, handlers);
		return () => {
			const current = this.hooks.get(hookName);
			if (!current) return;
			const remaining = current.filter((candidate) => candidate !== registration);
			if (remaining.length === 0) this.hooks.delete(hookName);
			else this.hooks.set(hookName, remaining);
		};
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.events.get(type) ?? [])
			void Promise.resolve()
				.then(() => listener(event))
				.catch((error: unknown) => console.error(`AgentHarness lifecycle event listener failed (${type})`, error));
	}

	async runHook(name: HookName, event: unknown): Promise<void> {
		for (const registration of this.hooks.get(name) ?? []) await registration.handler(event);
	}

	onEvent(type: string, listener: (event: unknown) => void | Promise<void>): () => void {
		if (this.isClosed()) throw new HarnessClosed();
		const listeners = this.events.get(type) ?? new Set();
		listeners.add(listener);
		this.events.set(type, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.events.delete(type);
		};
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
	rollback(turns: number): Promise<RollbackResult>;
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
	private readonly lifecycle: LifecycleRegistry;
	private readonly watchBus = new HarnessEventBus();
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
	private suspendedOperations: SuspendedOperation[] = [];
	private closed = false;
	private activeOperation:
		| {
				id: string;
				kind: "run" | "compaction" | "navigation";
				controller: AbortController;
				done: Promise<void>;
				resolveDone: () => void;
		  }
		| undefined;
	private readonly finishedOperations = new Set<string>();
	private readonly finishingOperations = new Map<string, Promise<void>>();
	/** Serializes durable lifecycle mutations (abort, terminal records, queue admission). */
	private lifecycleTail: Promise<void> = Promise.resolve();
	/** Queue entries claimed by an in-flight run before their transcript entry is durable. */
	private readonly claimedQueueItems = new Set<string>();
	private missingModels: string[] = [];
	private missingTools: string[] = [];
	private static readonly finishedOperationCacheLimit = 1024;

	private constructor(options: AgentHarnessOptions) {
		this.durableSession = options.session;
		this.models = options.models;
		this.systemPromptSource = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages;
		this.session = options.session;
		this.lifecycle = new LifecycleRegistry(() => this.closed);
		this.hooks = this.lifecycle;
		this.events = { on: (type, listener) => this.lifecycle.onEvent(type, listener) };
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
		harness.suspendedOperations = structuredClone(suspended);
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
		if (typeof input === "string" && input.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "prompt_too_large",
					message: `Prompt exceeds ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}),
			);
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
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const busy = await this.withLifecycleLock(async () => {
			if (this.closed) return { operationId: localRunId, operationKind: "run" as const, message: "Harness is closed" };
			if (this.activeOperation)
				return {
					operationId: this.activeOperation.id,
					operationKind: this.activeOperation.kind,
					message: "Lane is busy",
				};
			const open = await this.openOperationsAcrossLanes();
			if (open.length > 0)
				return { operationId: open[0]!.id, operationKind: open[0]!.intent.kind, message: "Lane is busy" };
			this.activeOperation = { id: localRunId, kind: "run", controller, done, resolveDone };
			return undefined;
		});
		if (busy) {
			if (busy.message === "Harness is closed") return ResultValue.err(new Closed({ message: busy.message }));
			return ResultValue.err(new LaneBusy(busy));
		}
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			resolveDone();
			if (this.activeOperation?.id === localRunId) this.activeOperation = undefined;
		};
		let prompts: AgentMessage[];
		try {
			prompts = this.normalizePromptInput(input, images);
		} catch (error) {
			release();
			throw error;
		}
		const runId = localRunId;
		const claimedQueueIds = new Set<string>();
		let nextRunItems: ProvisionedEntry[];
		try {
			nextRunItems = await this.claimQueueItems("nextRun", undefined, claimedQueueIds);
		} catch (error) {
			// Queue discovery happens before operation_started is durable. A storage
			// failure here must not strand the local lane admission or its completion
			// promise, otherwise subsequent prompts and aborts observe a phantom run.
			this.releaseQueueClaims(claimedQueueIds);
			release();
			throw error;
		}
		const initialMessages = [
			...nextRunItems,
			...prompts.map((message) => ({
				type: "message" as const,
				id: this.durableSession.idGenerator.next(),
				message: durableClone(message),
			})),
		];
		const messageTargets = new Map<AgentMessage, ProvisionedEntry>();
		for (const item of nextRunItems) messageTargets.set(item.message, item);
		prompts.forEach((message, index) => messageTargets.set(message, initialMessages[nextRunItems.length + index]!));
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
					initialMessages,
				},
			};
		} catch (error) {
			this.releaseQueueClaims(claimedQueueIds);
			release();
			throw error;
		}
		let startedEventEmitted = false;
		try {
			if (this.closed || controller.signal.aborted) throw new HarnessClosed();
			await this.durableSession.appendRecord(started);
			this.lifecycle.emit("operation_started", { operationId: runId, kind: "run" });
			this.watchBus.emit({ type: "run_start", lane: "main", runId });
			startedEventEmitted = true;
		} catch (error) {
			const raced = await this.durableSession.findOpenOperations("main", { limit: 1 }).catch(() => []);
			if (raced.length > 0 && raced[0]!.id === runId) {
				// Some remote stores can commit before reporting a transport error.
				// Continue the operation when our own start is durably visible.
			} else if (raced.length > 0) {
				this.releaseQueueClaims(claimedQueueIds);
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
				this.releaseQueueClaims(claimedQueueIds);
				release();
				throw error;
			}
			if (!startedEventEmitted) {
				this.lifecycle.emit("operation_started", { operationId: runId, kind: "run" });
				startedEventEmitted = true;
			}
		}
		try {
			await this.lifecycle.runHook("before_run", { operationId: runId, prompts: durableClone(prompts) });
			const entries = await this.durableSession.findEntriesOnBranch({ order: "oldestFirst" });
			const persisted = buildSessionContext(entries);
			const systemPrompt =
				typeof this.systemPromptSource === "function"
					? await this.systemPromptSource()
					: (this.systemPromptSource ?? "");
			const activeTools = this.tools.filter((tool) => this.activeToolNames.includes(tool.name));
			const newMessages = await runAgentLoop(
				[...nextRunItems.map((item) => item.message), ...prompts],
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
					getSteeringMessages: async () => {
						const selected = await this.claimQueueItems("steer", runId, claimedQueueIds, this.steeringMode);
						for (const item of selected) messageTargets.set(item.message, item);
						return selected.map((item) => item.message);
					},
					getFollowUpMessages: async () => {
						const selected = await this.claimQueueItems("followUp", runId, claimedQueueIds, this.followUpMode);
						for (const item of selected) messageTargets.set(item.message, item);
						return selected.map((item) => item.message);
					},
				},
				async () => {},
					controller.signal,
				this.models.streamSimple.bind(this.models),
			);
			let finalEntryId: string | undefined;
			const transcriptMessages = newMessages.map(sanitizeTranscriptMessage);
			for (const [index, message] of transcriptMessages.entries()) {
				const sourceMessage = newMessages[index];
				const target = messageTargets.get(sourceMessage);
				finalEntryId = target
					? (await this.durableSession.appendEntry({ ...target, message: durableClone(message) }, "main")).id
					: await this.durableSession.appendMessage(durableClone(message));
				if (message.role === "assistant" && message.stopReason !== "pending" && message.usage !== undefined)
					await this.durableSession.appendRecord({
						type: "usage",
						id: this.durableSession.idGenerator.next(),
						lane: "main",
						usage: durableClone(message.usage),
						cause: "assistant",
						runId,
						entryId: finalEntryId,
						attempt: 1,
						stopReason: message.stopReason,
					});
			}
			const finalMessage = transcriptMessages.at(-1);
			if (!finalEntryId || !finalMessage || finalMessage.role !== "assistant")
				throw new Error("Agent loop produced no assistant message");
			await this.lifecycle.runHook("after_response", { operationId: runId, message: durableClone(finalMessage) });
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
			this.releaseQueueClaims(claimedQueueIds);
			release();
		}
	}

	private async finishOperation(
		runId: string,
		outcome: OperationFinishedRecord["outcome"],
		error?: OperationFinishedRecord["error"],
		alreadyLocked = false,
	): Promise<void> {
		if (this.finishedOperations.has(runId)) return;
		const existingAttempt = this.finishingOperations.get(runId);
		if (existingAttempt) return existingAttempt;
		const operation = async () => {
			const existing = await this.durableSession.findRecords({ type: "operation_finished", runId, limit: 1 });
			if (existing.length > 0) {
				this.rememberFinishedOperation(runId);
				return;
			}
			try {
				await this.lifecycle.runHook("before_run_end", { operationId: runId, outcome });
			} catch (hookError) {
				console.error("AgentHarness before_run_end hook failed", hookError);
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
			this.lifecycle.emit("operation_finished", { operationId: runId, outcome });
			this.watchBus.emit({ type: "run_end", lane: "main", runId, outcome: outcome === "aborted" ? "aborted" : outcome === "failed" ? "failed" : "completed", leafId: (await this.durableSession.getLeafId()) ?? "" });
		};
		const attempt = alreadyLocked ? operation() : this.withLifecycleLock(operation);
		this.finishingOperations.set(runId, attempt);
		try {
			await attempt;
		} finally {
			if (this.finishingOperations.get(runId) === attempt) this.finishingOperations.delete(runId);
		}
	}

	private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.lifecycleTail;
		let release!: () => void;
		this.lifecycleTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		return previous
			.catch(() => undefined)
			.then(operation)
			.finally(release);
	}

	private async openOperationsAcrossLanes(): Promise<OperationStartedRecord[]> {
		const lanes = await this.durableSession.getLanes();
		const operations = await Promise.all(
			lanes.map((lane) => this.durableSession.findOpenOperations(lane.lane, { limit: 1 })),
		);
		return operations.flat();
	}

	private rememberFinishedOperation(runId: string): void {
		this.finishedOperations.add(runId);
		if (this.finishedOperations.size <= AgentHarness.finishedOperationCacheLimit) return;
		const oldest = this.finishedOperations.values().next().value as string | undefined;
		if (oldest !== undefined) this.finishedOperations.delete(oldest);
	}

	private async pendingQueueItems(
		queue: QueueEnqueuedRecord["queue"],
		runId?: string,
	): Promise<ProvisionedEntry[]> {
		const records = await this.durableSession.findRecords({ type: "queue_enqueued", lane: "main", order: "oldestFirst" });
		const cancelled = new Set(
			(await this.durableSession.findRecords({ type: "queue_cancelled", lane: "main" })).map((record) => record.entryId),
		);
		const entries = await this.durableSession.findEntriesOnBranch({ order: "oldestFirst" });
		const existing = new Set(entries.map((entry) => entry.id));
		return records
			.filter(
				(record): record is QueueEnqueuedRecord =>
					record.queue === queue &&
					(queue === "nextRun" || record.runId === runId) &&
					!cancelled.has(record.target.id) &&
					!existing.has(record.target.id) &&
					record.target.type === "message",
			)
			.map((record) => ({ ...record.target, message: structuredClone(record.target.message) }));
	}

	private async claimQueueItems(
		queue: QueueEnqueuedRecord["queue"],
		runId: string | undefined,
		localClaims: Set<string>,
		mode?: QueueMode,
	): Promise<ProvisionedEntry[]> {
		return this.withLifecycleLock(async () => {
			const items = (await this.pendingQueueItems(queue, runId)).filter(
				(item) => !localClaims.has(item.id) && !this.claimedQueueItems.has(item.id),
			);
			const selected = mode === "all" ? items : mode === undefined ? items : items.slice(0, 1);
			for (const item of selected) {
				localClaims.add(item.id);
				this.claimedQueueItems.add(item.id);
			}
			return selected;
		});
	}

	private releaseQueueClaims(claims: Set<string>): void {
		for (const entryId of claims) this.claimedQueueItems.delete(entryId);
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) return structuredClone(input);
		if (typeof input !== "string") return [structuredClone(input)];
		return [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }];
	}
	async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const skill = this.resources.skills?.find((candidate) => candidate.name === name);
		if (!skill) return ResultValue.err(new UnknownSkill({ name, message: `Unknown skill: ${name}` }));
		if (skill.content.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "skill_content_too_large",
					message: `Skill content exceeds ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}),
			);
		if (additionalInstructions !== undefined && additionalInstructions.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "skill_instructions_too_large",
					message: `Skill instructions exceed ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}),
			);
		const prompt = formatSkillInvocation(skill, additionalInstructions);
		if (prompt.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "skill_prompt_too_large",
					message: `Skill prompt exceeds ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}),
			);
		return this.prompt(prompt);
	}
	async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === name);
		if (!template) return ResultValue.err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
		if (template.content.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "template_content_too_large",
					message: `Prompt template content exceeds ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}),
			);
		if (args.length > 64 || args.some((argument) => argument.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH))
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "template_arguments_too_large",
					message: "Prompt template arguments exceed configured limits",
				}),
			);
		const prompt = formatPromptTemplateInvocation(template, args);
		if (prompt.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			return ResultValue.err(
				new InvalidMessage({
					lane: "main",
					reason: "template_prompt_too_large",
					message: `Prompt template exceeds ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`,
				}),
			);
		return this.prompt(prompt);
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
		let startedEventEmitted = false;
		try {
			try {
				await this.lifecycle.runHook("before_compaction", { operationId: runId, model: this.model });
				await this.durableSession.appendRecord({
					type: "operation_started",
					id: runId,
					lane: "main",
					sourceLeafId: await this.durableSession.getLeafId(),
					intent: { kind: "compaction", resultEntryId, customInstructions: _options?.customInstructions },
				});
				this.lifecycle.emit("operation_started", { operationId: runId, kind: "compaction" });
				startedEventEmitted = true;
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
			if (!startedEventEmitted) {
				this.lifecycle.emit("operation_started", { operationId: runId, kind: "compaction" });
				startedEventEmitted = true;
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
	async navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		return this.withLifecycleLock(async () => {
			if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
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
			const open = await this.openOperationsAcrossLanes();
			if (open.length > 0) {
				return ResultValue.err(
					new LaneBusy({
						lane: "main",
						operationId: open[0]!.id,
						operationKind: open[0]!.intent.kind,
						message: "Lane is busy",
					}),
				);
			}
			if (targetId !== null && !(await this.durableSession.getEntry(targetId)))
				return ResultValue.err(new UnknownTarget({ targetId, message: `Unknown navigation target: ${targetId}` }));
			const oldLeafId = await this.durableSession.getLeafId();
			if (oldLeafId === targetId)
				return ResultValue.ok({ runId: this.durableSession.idGenerator.next(), kind: "completed", newLeafId: targetId });
			const customInstructions =
				options?.customInstructions === undefined
					? undefined
					: sanitizeErrorMessage(options.customInstructions, "", MAX_DURABLE_COMPACTION_TEXT_LENGTH, true);
			const label = options?.label === undefined ? undefined : sanitizeErrorMessage(options.label, "", 256, true);
			const summarize = options?.summarize === true;
			const runId = this.durableSession.idGenerator.next();
			const summaryEntryId = summarize ? this.durableSession.idGenerator.next() : undefined;
			const controller = new AbortController();
			let resolveDone!: () => void;
			const done = new Promise<void>((resolve) => {
				resolveDone = resolve;
			});
			this.activeOperation = { id: runId, kind: "navigation", controller, done, resolveDone };
			let started = false;
			let startedEventEmitted = false;
			try {
				await this.lifecycle.runHook("before_navigation", { operationId: runId, targetId, summarize });
				await this.durableSession.appendRecord({
					type: "operation_started",
					id: runId,
					lane: "main",
					sourceLeafId: oldLeafId,
					intent: {
						kind: "navigation",
						targetId,
						summarize,
						...(customInstructions === undefined ? {} : { customInstructions }),
						...(label === undefined ? {} : { label }),
						...(summaryEntryId ? { summaryEntryId } : {}),
					},
				});
				started = true;
				this.lifecycle.emit("operation_started", { operationId: runId, kind: "navigation" });
				startedEventEmitted = true;
				let summary: BranchSummaryResult | undefined;
				if (summarize && oldLeafId) {
					const collected = await collectEntriesForBranchSummary(this.durableSession, oldLeafId, targetId ?? oldLeafId);
					const generated = await generateBranchSummary(collected.entries, {
						models: this.models,
						model: this.model,
						signal: controller.signal,
						customInstructions,
						retry: this.retryPolicy,
					});
					if (!generated.ok) {
						const message = sanitizeErrorMessage(generated.error.message, "Navigation summary failed");
						await this.finishOperation(
							runId,
							generated.error.code === "aborted" ? "aborted" : "failed",
							{ code: generated.error.code, message },
							true,
						);
						return ResultValue.ok(
							generated.error.code === "aborted"
								? { runId, kind: "aborted" as const, leafId: oldLeafId }
								: { runId, kind: "failed" as const, leafId: oldLeafId, error: { code: generated.error.code, message } },
						);
					}
					summary = generated.value;
				}
				if (controller.signal.aborted || this.closed) throw new HarnessClosed();
				await this.durableSession.moveLane("main", targetId);
				let summaryEntry: BranchSummaryEntry | undefined;
				if (summary && summaryEntryId) {
					summaryEntry = await this.durableSession.appendEntry<BranchSummaryEntry>(
						{
							type: "branch_summary",
							id: summaryEntryId,
							fromId: oldLeafId ?? "",
							summary: sanitizeErrorMessage(summary.summary, "Navigation summary unavailable", MAX_DURABLE_COMPACTION_TEXT_LENGTH, true),
							details: {
								readFiles: summary.readFiles.slice(0, 256).map((file) => sanitizeErrorMessage(file, "", 512, true)),
								modifiedFiles: summary.modifiedFiles.slice(0, 256).map((file) => sanitizeErrorMessage(file, "", 512, true)),
							},
							...(summary.usage === undefined ? {} : { usage: structuredClone(summary.usage) }),
						},
						"main",
					);
				}
				if (label !== undefined && targetId !== null) await this.durableSession.setLabel(targetId, label);
				await this.finishOperation(runId, "completed", undefined, true);
				return ResultValue.ok({ runId, kind: "completed", newLeafId: summaryEntry?.id ?? targetId, summaryEntry });
			} catch (error) {
				const message = sanitizeErrorMessage(error, "Navigation failed");
				if (!started) {
					const committed = await this.durableSession.findOpenOperations("main", { limit: 1 }).catch(() => []);
					started = committed.some((operation) => operation.id === runId);
				}
				if (started && !startedEventEmitted) {
					this.lifecycle.emit("operation_started", { operationId: runId, kind: "navigation" });
					startedEventEmitted = true;
				}
				let restored = true;
				try {
					if (started && (await this.durableSession.getLeafId()) !== oldLeafId) await this.durableSession.moveLane("main", oldLeafId);
				} catch {
					restored = false;
				}
				const failure = restored ? message : "Navigation failed: lane restoration was not confirmed";
				const terminal = started
					? await this.durableSession.findRecords({ type: "operation_finished", runId, limit: 1 }).catch(() => [])
					: [];
				if (started && terminal.length === 0)
					await this.finishOperation(
						runId,
						controller.signal.aborted ? "aborted" : "failed",
						{ code: controller.signal.aborted ? "aborted" : "navigation_failed", message: failure },
						true,
					);
				if (controller.signal.aborted) throw new HarnessClosed();
				return ResultValue.ok({ runId, kind: "failed", leafId: oldLeafId, error: { code: "navigation_failed", message: failure } });
			} finally {
				if (this.activeOperation?.id === runId) this.activeOperation = undefined;
				resolveDone();
			}
		});
	}
	async rollback(turns: number): Promise<RollbackResult> {
		return this.withLifecycleLock(async () => {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		if (!Number.isInteger(turns) || turns < 1) {
			return ResultValue.err(
				new InvalidRollback({ lane: "main", message: "Rollback requires a positive turn count" }),
			);
		}
		if (this.activeOperation)
			return ResultValue.err(
				new LaneBusy({
					lane: "main",
					operationId: this.activeOperation.id,
					operationKind: this.activeOperation.kind,
					message: "Lane is busy",
				}),
			);
		const open = await this.openOperationsAcrossLanes();
		if (open.length > 0) {
			return ResultValue.err(
				new LaneBusy({
					lane: "main",
					operationId: open[0]!.id,
					operationKind: open[0]!.intent.kind,
					message: "Lane is busy",
				}),
			);
		}
		const entries = await this.durableSession.findEntriesOnBranch({ order: "oldestFirst" });
		const userEntries = entries.filter(
			(entry): entry is Extract<Entry, { type: "message" }> =>
				entry.type === "message" && entry.message.role === "user",
		);
		if (turns > userEntries.length) {
			return ResultValue.err(
				new InvalidRollback({ lane: "main", message: "Rollback exceeds surviving user turns" }),
			);
		}
		const target = turns === userEntries.length ? null : userEntries[userEntries.length - turns]!.parentId;
		const previousTarget = await this.durableSession.getLeafId();
		const rollbackId = this.durableSession.idGenerator.next();
		await this.durableSession.moveLane("main", target);
		try {
			await this.durableSession.appendCustomEntry("conversation_rollback", {
				rollbackId,
				removedTurns: turns,
				targetId: target,
			});
		} catch (error) {
			const committed = (await this.durableSession.findEntriesOnBranch({ order: "newestFirst", limit: 1 })).some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "conversation_rollback" &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					(entry.data as { rollbackId?: unknown }).rollbackId === rollbackId,
			);
			if (committed) return ResultValue.ok({ targetId: target, removedTurns: turns });
			try {
				await this.durableSession.moveLane("main", previousTarget);
			} catch (restoreError) {
				throw new Error("Rollback reconciliation failed: lane restoration was not confirmed", { cause: restoreError });
			}
			throw error;
		}
		return ResultValue.ok({ targetId: target, removedTurns: turns });
		});
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const recovered = await this.withLifecycleLock(async () => {
			if (this.closed) return { error: new Closed({ message: "AgentHarness is closed" }) } as const;
			if (this.activeOperation) {
				return {
					error: new LaneBusy({
						lane: "main",
						operationId: this.activeOperation.id,
						operationKind: this.activeOperation.kind,
						message: "Lane is busy",
					}),
				} as const;
			}
			const lanes = await this.durableSession.getLanes();
			const openByLane = await Promise.all(
				lanes.map(async (lane) => ({ lane: lane.lane, operations: await this.durableSession.findOpenOperations(lane.lane) })),
			);
			const open = openByLane.flatMap((entry) => entry.operations);
			const duplicateLane = openByLane.find((entry) => entry.operations.length > 1);
			if (duplicateLane) {
				const operation = duplicateLane.operations[0]!;
				return {
					error: new LaneBusy({
						lane: duplicateLane.lane,
						operationId: operation.id,
						operationKind: operation.intent.kind,
						message: "Multiple open operations require recovery before resume",
					}),
				} as const;
			}
			if (open.length > 1) {
				const operation = open[0]!;
				return {
					error: new LaneBusy({
						lane: operation.lane,
						operationId: operation.id,
						operationKind: operation.intent.kind,
						message: "Open operations in multiple lanes require recovery before resume",
					}),
				} as const;
			}
			const operation = open[0];
			if (!operation) return { error: new NothingToResume({ lane: "main", message: "Nothing to resume" }) } as const;
			if (operation.lane !== "main") {
				return {
					error: new LaneBusy({
						lane: operation.lane,
						operationId: operation.id,
						operationKind: operation.intent.kind,
						message: "Suspended operation requires a lane-specific harness",
					}),
				} as const;
			}
			const suspended = this.suspendedOperations.find(
				(candidate) =>
					candidate.id === operation.id &&
					candidate.lane === operation.lane &&
					candidate.kind === operation.intent.kind &&
					candidate.startedAt === operation.timestamp,
			);
			if (!suspended) return { error: new NothingToResume({ lane: operation.lane, message: "Nothing to resume" }) } as const;
			if (suspended.missing.models.length > 0 || suspended.missing.tools.length > 0) {
				return {
					error: new MissingIdentities({
						lane: operation.lane,
						tools: [...suspended.missing.tools],
						models: [...suspended.missing.models],
						message: "Resume requires missing tools or models",
					}),
				} as const;
			}
			const terminal = await this.durableSession.findRecords({ type: "operation_finished", runId: operation.id, limit: 1 });
			if (terminal.length === 0)
				await this.durableSession.appendRecord({
					type: "operation_finished",
					id: this.durableSession.idGenerator.next(),
					lane: operation.lane,
					runId: operation.id,
					outcome: "failed",
					error: { code: "recovered_by_resume", message: "Suspended operation was reopened by resume" },
				});
			return { operation } as const;
		});
		if ("error" in recovered) return ResultValue.err(recovered.error);
		const { operation } = recovered;
		if (operation.intent.kind === "run") {
			const result = await this.prompt(operation.intent.originalPrompt);
			if (!result.ok)
				return ResultValue.ok({
					operation: "run",
					runId: operation.id,
					kind: "failed",
					leafId: (await this.durableSession.getLeafId()) ?? "",
					error: { code: result.error.name, message: result.error.message },
				});
			const { runId, ...outcome } = result.value;
			return ResultValue.ok({ operation: "run", runId, ...outcome });
		}
		if (operation.intent.kind === "compaction") {
			const result = await this.compact({ customInstructions: operation.intent.customInstructions });
			if (!result.ok)
				return ResultValue.ok({
					operation: "compaction",
					runId: operation.id,
					kind: "failed",
					leafId: (await this.durableSession.getLeafId()) ?? "",
					error: { code: result.error.name, message: result.error.message },
				});
			const { runId, ...outcome } = result.value;
			return ResultValue.ok({ operation: "compaction", runId, ...outcome });
		}
		const result = await this.navigateTree(operation.intent.targetId, {
			summarize: operation.intent.summarize,
			customInstructions: operation.intent.customInstructions,
			label: operation.intent.label,
		});
		if (!result.ok)
			return ResultValue.ok({
				operation: "navigation",
				runId: operation.id,
				kind: "failed",
				leafId: await this.durableSession.getLeafId(),
				error: { code: result.error.name, message: result.error.message },
			});
		const { runId, ...outcome } = result.value;
		return ResultValue.ok({ operation: "navigation", runId, ...outcome });
	}
	async abort(): Promise<AbortResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const activeNavigation = this.activeOperation?.kind === "navigation" ? this.activeOperation : undefined;
		if (activeNavigation) {
			activeNavigation.controller.abort();
			await activeNavigation.done;
			return ResultValue.ok({ runId: activeNavigation.id, steer: [], followUp: [] });
		}
		const request = await this.withLifecycleLock(async () => {
			if (this.closed) return undefined;
			// Recheck under the same lifecycle lock used by finishOperation. This
			// prevents an abort marker from being appended after a terminal record.
			const openRun = (await this.durableSession.findOpenOperations("main", { limit: 1 })).find(
				(operation) => operation.intent.kind === "run",
			);
			const active = this.activeOperation?.kind === "run" ? this.activeOperation : undefined;
			// prompt() admits a local run before operation_started is durable. In
			// that window there is no record to mark, but abort still needs to signal
			// and await the local operation rather than reporting a phantom idle lane.
			if (!openRun && active) return { runId: active.id, active, durable: false, recalled: { steer: [], followUp: [] } };
			if (!openRun) return undefined;
			const durableActive = active?.id === openRun.id ? active : undefined;
			await this.durableSession.appendRecord({
				type: "abort_requested",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId: openRun.id,
			});
			const queued = await this.durableSession.findRecords({
				type: "queue_enqueued",
				lane: "main",
				order: "oldestFirst",
			});
			const cancelled = new Set(
				(await this.durableSession.findRecords({ type: "queue_cancelled", lane: "main" })).map(
					(record) => record.entryId,
				),
			);
			const recalled = { steer: [] as AgentMessage[], followUp: [] as AgentMessage[] };
			for (const item of queued) {
				if (
					item.queue === "nextRun" ||
					item.runId !== openRun.id ||
					cancelled.has(item.target.id) ||
					this.claimedQueueItems.has(item.target.id) ||
					item.target.type !== "message"
				)
					continue;
				recalled[item.queue].push(structuredClone(item.target.message));
				cancelled.add(item.target.id);
				await this.durableSession.appendRecord({
					type: "queue_cancelled",
					id: this.durableSession.idGenerator.next(),
					lane: "main",
					runId: openRun.id,
					entryId: item.target.id,
				} satisfies NewRecord<QueueCancelledRecord>);
			}
			return { runId: openRun.id, active: durableActive, durable: true, recalled };
		});
		if (!request) return ResultValue.err(new NoActiveOperation({ lane: "main", message: "No active operation" }));
		request.active?.controller.abort();
		await request.active?.done;
		if (!request.durable) return ResultValue.ok({ runId: request.runId, ...request.recalled });
		// Remote/recovered runs have no local controller. Persist a durable
		// terminal outcome rather than waiting on an unrelated local operation.
		await this.finishOperation(request.runId, "aborted", { code: "aborted", message: "Run aborted" });
		return ResultValue.ok({ runId: request.runId, ...request.recalled });
	}
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue(input, images, "steer", true);
	}
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue(input, images, "followUp", true);
	}
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue(input, images, "nextRun", false);
	}
	async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		return this.withLifecycleLock(async () => {
			if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
			const enqueued = (await this.durableSession.findRecords({ type: "queue_enqueued", lane: "main" })).find(
				(record) => record.target.id === entryId,
			);
			if (!enqueued)
				return ResultValue.err(new UnknownQueueItem({ lane: "main", entryId, message: "Queued item not found" }));
			const cancelled = (await this.durableSession.findRecords({ type: "queue_cancelled", lane: "main" })).some(
				(record) => record.entryId === entryId,
			);
			if (cancelled) return ResultValue.ok({ outcome: "already_cleared" });
			if (this.claimedQueueItems.has(entryId)) return ResultValue.ok({ outcome: "already_consumed" });
			const entries = await this.durableSession.findEntriesOnBranch({ order: "oldestFirst" });
			if (entries.some((entry) => entry.id === entryId)) return ResultValue.ok({ outcome: "already_consumed" });
			await this.durableSession.appendRecord(
				enqueued.queue === "nextRun"
					? { type: "queue_cancelled", id: this.durableSession.idGenerator.next(), lane: "main", entryId }
					: {
							type: "queue_cancelled",
							id: this.durableSession.idGenerator.next(),
							lane: "main",
							runId: enqueued.runId,
							entryId,
						} satisfies NewRecord<QueueCancelledRecord>,
			);
			return ResultValue.ok({ outcome: "cancelled" });
		});
	}

	private async enqueue(
		input: string | AgentMessage,
		images: ImageContent[] | undefined,
		queue: QueueEnqueuedRecord["queue"],
		requiresRun: boolean,
	): Promise<QueueResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const message: AgentMessage =
			typeof input === "string"
				? { role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }
				: structuredClone(input);
		const target: ProvisionedEntry = { type: "message", id: this.durableSession.idGenerator.next(), message };
		return this.withLifecycleLock(async () => {
			if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
			const openRun = (await this.durableSession.findOpenOperations("main", { limit: 1 })).find(
				(operation) => operation.intent.kind === "run",
			);
			const localRun = this.activeOperation?.kind === "run" ? this.activeOperation : undefined;
			const runId = openRun?.id ?? localRun?.id;
			const aborting = runId
				? (await this.durableSession.findRecords({ type: "abort_requested", lane: "main" })).some(
						(record) => record.runId === runId,
					)
				: false;
			if (requiresRun && (!runId || aborting)) return ResultValue.err(new NoActiveRun({ lane: "main", message: "No active run" }));
			const record: NewRecord<QueueEnqueuedRecord> =
				queue === "nextRun"
					? { type: "queue_enqueued", id: this.durableSession.idGenerator.next(), lane: "main", queue, target }
					: {
							type: "queue_enqueued",
							id: this.durableSession.idGenerator.next(),
							lane: "main",
							queue,
							runId: runId!,
							target,
						};
			await this.durableSession.appendRecord(record);
			return ResultValue.ok({ entryId: target.id });
		});
	}
	async recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		try {
			const record: NewRecord<UsageRecord> = {
				type: "usage",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				usage: structuredClone(usage),
				cause: "adjustment",
				entryId: options?.entryId,
				details: options?.details,
			};
			await this.durableSession.appendRecord(record);
			return ResultValue.ok(undefined);
		} catch (error) {
			throw new HarnessFault("Unable to persist usage record", error);
		}
	}
	async waitForIdle(): Promise<void> {
		while (true) {
			if (this.closed) throw new HarnessClosed();
			if (this.activeOperation) {
				await this.activeOperation.done;
				continue;
			}
			const open = await this.durableSession.findOpenOperations("main", { limit: 1 });
			if (open.length === 0) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
	}
	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		await this.waitForIdle();
		if (this.closed) throw new HarnessClosed();
		await callback();
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
		return this.watchBus.watchAsync(() => this.laneSnapshot("main"));
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
		return this.watchBus.watchAsync(() => this.sessionSnapshot());
	}

	private async laneSnapshot(lane: string): Promise<LaneSnapshot> {
		const [leafId, transcript, open] = await Promise.all([
			this.durableSession.getLeafId(),
			this.durableSession.findEntriesOnBranch({ order: "oldestFirst" }),
			this.durableSession.findOpenOperations(lane, { limit: 1 }),
		]);
		const operation = open[0];
		const runId = operation?.intent.kind === "run" ? operation.id : undefined;
		const [steer, followUp, nextRun] = await Promise.all([
			this.pendingQueueItems("steer", runId),
			this.pendingQueueItems("followUp", runId),
			this.pendingQueueItems("nextRun"),
		]);
		const toQueuedItem = (entry: ProvisionedEntry): QueuedItem => ({ id: entry.id, message: structuredClone(entry.message) });
		return {
			lane,
			transcript,
			leafId,
			operation: operation ? { id: operation.id, kind: operation.intent.kind, status: "running" } : null,
			queues: { steer: steer.map(toQueuedItem), followUp: followUp.map(toQueuedItem), nextRun: nextRun.map(toQueuedItem) },
			faulted: false,
		};
	}

	private async sessionSnapshot(): Promise<SessionSnapshot> {
		const snapshot = await this.laneSnapshot("main");
		return { lanes: [{ name: "main", leafId: snapshot.leafId, operation: snapshot.operation }], faulted: false };
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
