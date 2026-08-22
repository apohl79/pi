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
	resolveCompactionSettings,
} from "./compaction/compaction.ts";
import { HarnessEventBus } from "./events.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { Result as ResultValue, TaggedError } from "./result.ts";
import { buildSessionContext } from "./session/context.ts";
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
	private readonly hooks = new Map<
		HookName,
		Array<{ id: string; handler: (event: unknown) => unknown | Promise<unknown> }>
	>();
	private readonly events = new Map<string, Set<(event: unknown) => void | Promise<void>>>();
	private nextId = 0;
	private readonly isClosed: () => boolean;

	constructor(isClosed: () => boolean) {
		this.isClosed = isClosed;
	}

	on(
		name: HookName | string,
		handler: (event: unknown) => unknown | Promise<unknown>,
		options?: { id?: string },
	): () => void {
		if (this.isClosed()) throw new HarnessClosed();
		const id = options?.id ?? `hook-${++this.nextId}`;
		const handlers = this.hooks.get(name as HookName) ?? [];
		const registration = { id, handler };
		if (handlers.some((candidate) => candidate.id === id)) throw new Error(`Duplicate lifecycle hook id: ${id}`);
		handlers.push(registration);
		this.hooks.set(name as HookName, handlers);
		return () => {
			const current = this.hooks.get(name as HookName);
			if (!current) return;
			const remaining = current.filter((candidate) => candidate !== registration);
			if (remaining.length === 0) this.hooks.delete(name as HookName);
			else this.hooks.set(name as HookName, remaining);
		};
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.events.get(type) ?? []) void Promise.resolve(listener(event));
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
	private readonly lifecycle: LifecycleRegistry;
	private readonly watchBus = new HarnessEventBus();
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
		const persistedThinking = branchEntries.find((entry) => entry.type === "thinking_level_change");
		if (persistedThinking?.type === "thinking_level_change") {
			const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			if (levels.includes(persistedThinking.thinkingLevel as ThinkingLevel)) {
				harness.thinkingLevel = persistedThinking.thinkingLevel as ThinkingLevel;
			}
		}
		const persistedTools = branchEntries.find((entry) => entry.type === "active_tools_change");
		if (persistedTools?.type === "active_tools_change") harness.activeToolNames = [...persistedTools.activeToolNames];
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
					missing: { tools: [], models: [...missingModels] },
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
		const open = await this.durableSession.findOpenOperations("main", { limit: 1 });
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
		const prompts = this.normalizePromptInput(input, images);
		const runId = this.durableSession.idGenerator.next();
		const started: NewRecord<OperationStartedRecord> = {
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
		await this.durableSession.appendRecord(started);
		this.lifecycle.emit("operation_started", { operationId: runId, kind: "run" });
		this.watchBus.emit({ type: "run_start", lane: "main", runId });
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
				undefined,
				this.models.streamSimple.bind(this.models),
			);
			let finalEntryId: string | undefined;
			for (const message of newMessages) {
				finalEntryId = await this.durableSession.appendMessage(durableClone(message));
				if (message.role === "assistant" && message.stopReason !== "pending") {
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
			}
			const finalMessage = newMessages.at(-1);
			if (!finalEntryId || !finalMessage || finalMessage.role !== "assistant")
				throw new Error("Agent loop produced no assistant message");
			await this.lifecycle.runHook("after_response", { operationId: runId, message: durableClone(finalMessage) });
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId,
				outcome: "completed",
			});
			await this.lifecycle.runHook("before_run_end", { operationId: runId, outcome: "completed" });
			this.lifecycle.emit("operation_finished", { operationId: runId, outcome: "completed" });
			this.watchBus.emit({
				type: "run_end",
				lane: "main",
				runId,
				outcome: "completed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
			});
			return ResultValue.ok({
				runId,
				kind: "completed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				finalEntryId,
				finalMessage,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId,
				outcome: "failed",
				error: { code: "run_failed", message },
			});
			this.watchBus.emit({
				type: "run_end",
				lane: "main",
				runId,
				outcome: "failed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
			});
			return ResultValue.ok({
				kind: "failed",
				runId,
				leafId: (await this.durableSession.getLeafId()) ?? "",
				error: { code: "run_failed", message },
			});
		}
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
		return this.prompt(formatSkillInvocation(skill, additionalInstructions));
	}
	async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === name);
		if (!template) return ResultValue.err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
		return this.prompt(formatPromptTemplateInvocation(template, args));
	}
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const open = await this.durableSession.findOpenOperations("main", { limit: 1 });
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
		const settings = resolveCompactionSettings(this.compactionSettings, this.model.provider, this.model.id);
		const preparation = prepareCompaction(entries, settings);
		if (!preparation.ok) {
			return ResultValue.ok({
				runId: this.durableSession.idGenerator.next(),
				kind: "failed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				error: { code: preparation.error.code, message: preparation.error.message },
			});
		}
		if (!preparation.value)
			return ResultValue.err(new NothingToCompact({ lane: "main", message: "Nothing to compact" }));
		const runId = this.durableSession.idGenerator.next();
		const resultEntryId = this.durableSession.idGenerator.next();
		await this.lifecycle.runHook("before_compaction", { operationId: runId, model: this.model });
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId: await this.durableSession.getLeafId(),
			intent: { kind: "compaction", resultEntryId, customInstructions: _options?.customInstructions },
		});
		try {
			const result = await compact(
				preparation.value,
				this.models,
				this.model,
				_options?.customInstructions,
				undefined,
				this.thinkingLevel,
				this.retryPolicy,
			);
			if (!result.ok) {
				await this.durableSession.appendRecord({
					type: "operation_finished",
					id: this.durableSession.idGenerator.next(),
					lane: "main",
					runId,
					outcome: result.error.code === "aborted" ? "aborted" : "failed",
					error: { code: result.error.code, message: result.error.message },
				});
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
					error: { code: result.error.code, message: result.error.message },
				});
			}
			const entry = await this.durableSession.appendEntry<CompactionEntry>(
				{
					type: "compaction",
					id: resultEntryId,
					summary: result.value.summary,
					retainedTail: durableClone(result.value.retainedTail),
					tokensBefore: result.value.tokensBefore,
					...(result.value.details === undefined ? {} : { details: durableClone(result.value.details) }),
					...(result.value.usage === undefined ? {} : { usage: durableClone(result.value.usage) }),
				},
				"main",
			);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId,
				outcome: "completed",
			});
			return ResultValue.ok({
				runId,
				kind: "completed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				entry,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId,
				outcome: "failed",
				error: { code: "compaction_failed", message },
			});
			return ResultValue.ok({
				runId,
				kind: "failed",
				leafId: (await this.durableSession.getLeafId()) ?? "",
				error: { code: "compaction_failed", message },
			});
		}
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const open = await this.durableSession.findOpenOperations("main", { limit: 1 });
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
		const targetId = _targetId;
		if (targetId !== null && !(await this.durableSession.getEntry(targetId))) {
			return ResultValue.err(new UnknownTarget({ targetId, message: `Unknown navigation target: ${targetId}` }));
		}
		const oldLeafId = await this.durableSession.getLeafId();
		if (oldLeafId === targetId) {
			return ResultValue.ok({
				runId: this.durableSession.idGenerator.next(),
				kind: "completed",
				newLeafId: targetId,
			});
		}
		const summarize = _options?.summarize === true;
		const runId = this.durableSession.idGenerator.next();
		const summaryEntryId = summarize ? this.durableSession.idGenerator.next() : undefined;
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
				...(_options?.customInstructions === undefined ? {} : { customInstructions: _options.customInstructions }),
				...(_options?.label === undefined ? {} : { label: _options.label }),
				...(summaryEntryId ? { summaryEntryId } : {}),
			},
		});
		try {
			let summary: BranchSummaryResult | undefined;
			if (summarize && oldLeafId) {
				const collected =
					targetId === null
						? {
								entries: await this.durableSession.findEntriesOnBranch({
									start: oldLeafId,
									order: "oldestFirst",
								}),
								commonAncestorId: null,
							}
						: await collectEntriesForBranchSummary(this.durableSession, oldLeafId, targetId);
				const generated = await generateBranchSummary(collected.entries, {
					models: this.models,
					model: this.model,
					signal: new AbortController().signal,
					customInstructions: _options?.customInstructions,
					retry: this.retryPolicy,
				});
				if (!generated.ok) {
					await this.durableSession.appendRecord({
						type: "operation_finished",
						id: this.durableSession.idGenerator.next(),
						lane: "main",
						runId,
						outcome: generated.error.code === "aborted" ? "aborted" : "failed",
						error: { code: generated.error.code, message: generated.error.message },
					});
					return ResultValue.ok({
						runId,
						...(generated.error.code === "aborted"
							? { kind: "aborted" as const, leafId: oldLeafId }
							: {
									kind: "failed" as const,
									leafId: oldLeafId,
									error: { code: generated.error.code, message: generated.error.message },
								}),
					});
				}
				summary = generated.value;
			}
			await this.durableSession.moveLane("main", targetId);
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summary && summaryEntryId) {
				summaryEntry = await this.durableSession.appendEntry<BranchSummaryEntry>(
					{
						type: "branch_summary",
						id: summaryEntryId,
						fromId: oldLeafId ?? "",
						summary: summary.summary,
						details: { readFiles: summary.readFiles, modifiedFiles: summary.modifiedFiles },
						...(summary.usage === undefined ? {} : { usage: structuredClone(summary.usage) }),
					},
					"main",
				);
			}
			if (_options?.label !== undefined && targetId !== null)
				await this.durableSession.setLabel(targetId, _options.label);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId,
				outcome: "completed",
			});
			return ResultValue.ok({ runId, kind: "completed", newLeafId: summaryEntry?.id ?? targetId, summaryEntry });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId,
				outcome: "failed",
				error: { code: "navigation_failed", message },
			});
			return ResultValue.ok({
				kind: "failed",
				runId,
				leafId: oldLeafId,
				error: { code: "navigation_failed", message },
			});
		}
	}
	async rollback(turns: number): Promise<RollbackResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		if (!Number.isInteger(turns) || turns < 1) {
			return ResultValue.err(
				new InvalidRollback({ lane: "main", message: "Rollback requires a positive turn count" }),
			);
		}
		const open = await this.durableSession.findOpenOperations("main", { limit: 1 });
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
		const lanes = await this.durableSession.getLanes();
		if (lanes.some((lane) => lane.lane !== "main" && lane.leafId !== null)) {
			return ResultValue.err(
				new InvalidRollback({ lane: "main", message: "Rollback requires no active descendant lanes" }),
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
		await this.durableSession.moveLane("main", target);
		await this.durableSession.appendCustomEntry("conversation_rollback", { removedTurns: turns, targetId: target });
		return ResultValue.ok({ targetId: target, removedTurns: turns });
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const open = await this.durableSession.findOpenOperations("main", { limit: 1 });
		const operation = open[0];
		if (!operation) return ResultValue.err(new NothingToResume({ lane: "main", message: "Nothing to resume" }));
		const suspended = this.suspendedOperations.find((candidate) => candidate.id === operation.id);
		if (suspended && (suspended.missing.models.length > 0 || suspended.missing.tools.length > 0)) {
			return ResultValue.err(
				new MissingIdentities({
					lane: "main",
					tools: [...suspended.missing.tools],
					models: [...suspended.missing.models],
					message: "Resume requires missing tools or models",
				}),
			);
		}
		await this.durableSession.appendRecord({
			type: "operation_finished",
			id: this.durableSession.idGenerator.next(),
			lane: "main",
			runId: operation.id,
			outcome: "failed",
			error: { code: "recovered_by_resume", message: "Suspended operation was reopened by resume" },
		});
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
		const openRun = (await this.durableSession.findOpenOperations("main", { limit: 1 })).find(
			(operation) => operation.intent.kind === "run",
		);
		if (!openRun) return ResultValue.err(new NoActiveOperation({ lane: "main", message: "No active operation" }));
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
				item.target.type !== "message"
			)
				continue;
			recalled[item.queue].push(structuredClone(item.target.message));
			cancelled.add(item.target.id);
			const cancellation: NewRecord<QueueCancelledRecord> = {
				type: "queue_cancelled",
				id: this.durableSession.idGenerator.next(),
				lane: "main",
				runId: openRun.id,
				entryId: item.target.id,
			};
			await this.durableSession.appendRecord(cancellation);
		}
		const requested: NewRecord<AbortRequestedRecord> = {
			type: "abort_requested",
			id: this.durableSession.idGenerator.next(),
			lane: "main",
			runId: openRun.id,
		};
		await this.durableSession.appendRecord(requested);
		const finished: NewRecord<OperationFinishedRecord> = {
			type: "operation_finished",
			id: this.durableSession.idGenerator.next(),
			lane: "main",
			runId: openRun.id,
			outcome: "aborted",
		};
		await this.durableSession.appendRecord(finished);
		this.watchBus.emit({
			type: "run_end",
			lane: "main",
			runId: openRun.id,
			outcome: "aborted",
			leafId: (await this.durableSession.getLeafId()) ?? "",
		});
		return ResultValue.ok({ runId: openRun.id, ...recalled });
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
		const enqueued = (await this.durableSession.findRecords({ type: "queue_enqueued", lane: "main" })).find(
			(record) => record.target.id === entryId,
		);
		if (!enqueued)
			return ResultValue.err(new UnknownQueueItem({ lane: "main", entryId, message: "Queued item not found" }));
		const cancelled = (await this.durableSession.findRecords({ type: "queue_cancelled", lane: "main" })).some(
			(record) => record.entryId === entryId,
		);
		if (cancelled) return ResultValue.ok({ outcome: "already_cleared" });
		const record: NewRecord<QueueCancelledRecord> =
			enqueued.queue === "nextRun"
				? { type: "queue_cancelled", id: this.durableSession.idGenerator.next(), lane: "main", entryId }
				: {
						type: "queue_cancelled",
						id: this.durableSession.idGenerator.next(),
						lane: "main",
						runId: enqueued.runId,
						entryId,
					};
		await this.durableSession.appendRecord(record);
		return ResultValue.ok({ outcome: "cancelled" });
	}

	private async enqueue(
		input: string | AgentMessage,
		images: ImageContent[] | undefined,
		queue: QueueEnqueuedRecord["queue"],
		requiresRun: boolean,
	): Promise<QueueResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const openRun = (await this.durableSession.findOpenOperations("main", { limit: 1 })).find(
			(operation) => operation.intent.kind === "run",
		);
		if (requiresRun && !openRun) return ResultValue.err(new NoActiveRun({ lane: "main", message: "No active run" }));
		const message: AgentMessage =
			typeof input === "string"
				? { role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }
				: structuredClone(input);
		const target: ProvisionedEntry = { type: "message", id: this.durableSession.idGenerator.next(), message };
		const record: NewRecord<QueueEnqueuedRecord> =
			queue === "nextRun"
				? { type: "queue_enqueued", id: this.durableSession.idGenerator.next(), lane: "main", queue, target }
				: {
						type: "queue_enqueued",
						id: this.durableSession.idGenerator.next(),
						lane: "main",
						queue,
						runId: openRun!.id,
						target,
					};
		await this.durableSession.appendRecord(record);
		return ResultValue.ok({ entryId: target.id });
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
				...(options?.entryId === undefined ? {} : { entryId: options.entryId }),
				...(options?.details === undefined ? {} : { details: options.details }),
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
		this.model = model;
		await this.durableSession.appendEntry(
			{
				type: "model_change",
				id: this.durableSession.idGenerator.next(),
				provider: model.provider,
				modelId: model.id,
			},
			"main",
		);
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		this.thinkingLevel = level;
		await this.durableSession.appendEntry(
			{ type: "thinking_level_change", id: this.durableSession.idGenerator.next(), thinkingLevel: level },
			"main",
		);
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		this.activeToolNames = [...names];
		await this.durableSession.appendEntry(
			{ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames: [...names] },
			"main",
		);
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		const snapshot = await this.laneSnapshot("main");
		return this.watchBus.watch(() => snapshot);
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
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
		await this.durableSession.appendEntry(
			{
				type: "active_tools_change",
				id: this.durableSession.idGenerator.next(),
				activeToolNames: [...this.activeToolNames],
			},
			"main",
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
		return resolveCompactionSettings(this.compactionSettings, this.model.provider, this.model.id);
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
		const snapshot = await this.sessionSnapshot();
		return this.watchBus.watch(() => snapshot);
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

	private async laneSnapshot(lane: string): Promise<LaneSnapshot> {
		const [leafId, transcript, open, queued, cancelled] = await Promise.all([
			this.durableSession.getLeafId(),
			this.durableSession.findEntriesOnBranch({ order: "oldestFirst" }),
			this.durableSession.findOpenOperations(lane, { limit: 1 }),
			this.durableSession.findRecords({ type: "queue_enqueued", lane, order: "oldestFirst" }),
			this.durableSession.findRecords({ type: "queue_cancelled", lane, order: "oldestFirst" }),
		]);
		const cancelledIds = new Set(cancelled.map((record) => record.entryId));
		const queues = { steer: [], followUp: [], nextRun: [] } as LaneSnapshot["queues"];
		for (const record of queued) {
			if (cancelledIds.has(record.target.id) || record.target.type !== "message") continue;
			queues[record.queue].push({ entryId: record.target.id, message: durableClone(record.target.message) });
		}
		const operation = open[0];
		return {
			lane,
			transcript,
			leafId,
			operation: operation
				? {
						id: operation.id,
						kind: operation.intent.kind,
						status: this.suspendedOperations.some((item) => item.id === operation.id) ? "suspended" : "running",
					}
				: null,
			queues,
			pendingWrites: [],
			faulted: false,
		};
	}

	private async sessionSnapshot(): Promise<SessionSnapshot> {
		const lanes = await this.durableSession.getLanes();
		return {
			lanes: await Promise.all(
				lanes.map(async (lane) => {
					const snapshot = await this.laneSnapshot(lane.lane);
					return {
						name: lane.lane,
						leafId: snapshot.leafId,
						operation: snapshot.operation,
						suspended: this.suspendedOperations.find((item) => item.lane === lane.lane),
					};
				}),
			),
			faulted: false,
		};
	}
}
