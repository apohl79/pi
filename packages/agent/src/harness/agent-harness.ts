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
import { type CompactionSettings, compact, prepareCompaction } from "./compaction/compaction.ts";
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

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
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
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
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
				undefined,
				this.models.streamSimple.bind(this.models),
			);
			let finalEntryId: string | undefined;
			for (const message of newMessages) {
				finalEntryId = await this.durableSession.appendMessage(durableClone(message));
			}
			const finalMessage = newMessages.at(-1);
			if (!finalEntryId || !finalMessage || finalMessage.role !== "assistant")
				throw new Error("Agent loop produced no assistant message");
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
	async skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		return this.unavailable("skill");
	}
	async promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		return this.unavailable("promptFromTemplate");
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
		const preparation = prepareCompaction(entries, this.compactionSettings);
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
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
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
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
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
		this.compactionSettings = { ...settings };
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
	}
}
