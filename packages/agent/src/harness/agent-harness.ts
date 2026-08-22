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
import type {
	AgentMessage,
	AgentTool,
	QueueMode,
	SamplingInput,
	SamplingInputContext,
	ThinkingLevel,
} from "../types.ts";
import {
	type BranchSummaryResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
} from "./compaction/branch-summarization.ts";
import {
	type CompactionSettings,
	compact,
	estimateTokens,
	prepareCompaction,
	resolveCompactionSettings,
	shouldCompact,
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

function persistedQueueMode(entry: Entry, customType: string): QueueMode | undefined {
	if (entry.type !== "custom" || entry.customType !== customType) return undefined;
	return entry.data === "all" || entry.data === "one-at-a-time" ? entry.data : undefined;
}

function persistedRetryPolicy(entry: Entry): RetryPolicy | undefined {
	if (entry.type !== "custom" || entry.customType !== "retry_policy_change") return undefined;
	if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (
		typeof data.enabled !== "boolean" ||
		!Number.isInteger(data.maxRetries) ||
		(data.maxRetries as number) < 0 ||
		typeof data.baseDelayMs !== "number" ||
		!Number.isFinite(data.baseDelayMs) ||
		(data.baseDelayMs as number) < 0
	)
		return undefined;
	return {
		enabled: data.enabled,
		maxRetries: data.maxRetries as number,
		baseDelayMs: data.baseDelayMs,
	};
}

function persistedCompactionSettings(entry: Entry): CompactionSettings | undefined {
	if (entry.type !== "custom" || entry.customType !== "compaction_settings_change") return undefined;
	if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (
		typeof data.enabled !== "boolean" ||
		typeof data.reserveTokens !== "number" ||
		!Number.isFinite(data.reserveTokens) ||
		data.reserveTokens < 0 ||
		typeof data.keepRecentTokens !== "number" ||
		!Number.isFinite(data.keepRecentTokens) ||
		data.keepRecentTokens < 0
	)
		return undefined;
	return {
		enabled: data.enabled,
		reserveTokens: data.reserveTokens,
		keepRecentTokens: data.keepRecentTokens,
	};
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

	hasHook(name: HookName): boolean {
		return (this.hooks.get(name)?.length ?? 0) > 0;
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
export type CompactionPolicySource = "global" | "model" | "mixed";

export interface AgentHarnessOptions {
	session: Session;
	lane?: string;
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
	samplingInput?: (context: SamplingInputContext) => AgentMessage[] | Promise<AgentMessage[]>;
	samplingInputFactory?: () => SamplingInput | Promise<SamplingInput>;
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
	getCompactionPolicySource(): Promise<CompactionPolicySource>;
	setCompactionEnabled(enabled: boolean): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	getQueueSnapshot(): Promise<LaneSnapshot["queues"]>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentHarness implements AgentLane {
	readonly name: string;
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly harnessOptions: AgentHarnessOptions;
	private readonly models: Models;
	private readonly systemPromptSource: AgentHarnessOptions["systemPrompt"];
	private readonly toProviderMessages: AgentHarnessOptions["toProviderMessages"];
	private readonly samplingInput: AgentHarnessOptions["samplingInput"];
	private readonly samplingInputFactory: AgentHarnessOptions["samplingInputFactory"];
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
	private readonly driveMode: "automatic" | "manual";
	private manualAction?: {
		info: ActionInfo;
		resolve: () => void;
		reject: (error: Error) => void;
	};
	private closed = false;

	private constructor(options: AgentHarnessOptions) {
		this.name = options.lane ?? "main";
		this.harnessOptions = { ...options };
		this.durableSession = options.session;
		this.models = options.models;
		this.systemPromptSource = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages;
		this.samplingInput = options.samplingInput;
		this.samplingInputFactory = options.samplingInputFactory;
		this.session = options.session.view(this.name);
		this.lifecycle = new LifecycleRegistry(() => this.closed);
		this.driveMode = options.drive ?? "automatic";
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
		const branchEntries = await options.session.view(harness.name).findEntriesOnBranch({ order: "newestFirst" });
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
		const persistedRetry = branchEntries.find((entry) => persistedRetryPolicy(entry) !== undefined);
		if (persistedRetry !== undefined) harness.retryPolicy = persistedRetryPolicy(persistedRetry)!;
		const persistedCompaction = branchEntries.find((entry) => persistedCompactionSettings(entry) !== undefined);
		if (persistedCompaction !== undefined)
			harness.compactionSettings = persistedCompactionSettings(persistedCompaction)!;
		const persistedSteering = branchEntries.find(
			(entry) => persistedQueueMode(entry, "steering_mode_change") !== undefined,
		);
		if (persistedSteering !== undefined)
			harness.steeringMode = persistedQueueMode(persistedSteering, "steering_mode_change")!;
		const persistedFollowUp = branchEntries.find(
			(entry) => persistedQueueMode(entry, "follow_up_mode_change") !== undefined,
		);
		if (persistedFollowUp !== undefined)
			harness.followUpMode = persistedQueueMode(persistedFollowUp, "follow_up_mode_change")!;
		const lanes = await options.session.getLanes();
		const suspended: SuspendedOperation[] = [];
		for (const lane of lanes.filter((candidate) => candidate.lane === harness.name)) {
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

	async getLeafId(): Promise<string | null> {
		return this.session.getLeafId();
	}

	private async estimateProviderRequestOverhead(): Promise<number> {
		const systemPrompt =
			typeof this.systemPromptSource === "function"
				? await this.systemPromptSource()
				: (this.systemPromptSource ?? "");
		const promptMessages: AgentMessage[] = [{ role: "user", content: systemPrompt, timestamp: 0 }];
		if (Array.isArray(this.samplingInput)) promptMessages.push(...this.samplingInput);
		const tools = this.tools
			.filter((tool) => this.activeToolNames.includes(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
		return (
			promptMessages.reduce((total, message) => total + estimateTokens(message), 0) +
			Math.ceil((JSON.stringify(tools)?.length ?? 0) / 4)
		);
	}

	async prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	async prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
		if (open.length > 0) {
			return ResultValue.err(
				new LaneBusy({
					lane: this.name,
					operationId: open[0]!.id,
					operationKind: open[0]!.intent.kind,
					message: "Lane is busy",
				}),
			);
		}
		const prompts = this.normalizePromptInput(input, images);
		const compactionSettings = resolveCompactionSettings(this.compactionSettings, this.model.provider, this.model.id);
		const stats = await this.session.getStats();
		const contextTokens =
			stats.totalTokens +
			prompts.reduce((total, message) => total + estimateTokens(message), 0) +
			(await this.estimateProviderRequestOverhead());
		if (shouldCompact(contextTokens, this.model.contextWindow ?? 128_000, compactionSettings)) {
			await this.compact();
		}
		const runId = this.durableSession.idGenerator.next();
		const started: NewRecord<OperationStartedRecord> = {
			type: "operation_started",
			id: runId,
			lane: this.name,
			sourceLeafId: await this.session.getLeafId(),
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
		this.watchBus.emit({ type: "run_start", lane: this.name, runId });
		try {
			await this.runLifecycleHook("before_run", { operationId: runId, prompts: durableClone(prompts) });
			const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
			const persisted = buildSessionContext(entries);
			const systemPrompt =
				typeof this.systemPromptSource === "function"
					? await this.systemPromptSource()
					: (this.systemPromptSource ?? "");
			const activeTools = this.tools.filter((tool) => this.activeToolNames.includes(tool.name));
			const samplingInput = this.samplingInputFactory ? await this.samplingInputFactory() : this.samplingInput;
			let assistantAttempt = 0;
			const newMessages = await runAgentLoop(
				prompts,
				{ systemPrompt, messages: persisted.messages, tools: activeTools },
				{
					...this.streamOptions,
					model: this.model,
					samplingInput,
					reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
					beforeAssistantResponse: async () => {
						assistantAttempt += 1;
						await this.park({ kind: "stream_assistant", step: "assistant", attempt: assistantAttempt });
					},
					beforeToolCall: async ({ toolCall }) => {
						await this.park({ kind: "execute_tool", toolCallId: toolCall.id, toolName: toolCall.name });
						return undefined;
					},
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
				finalEntryId = await this.session.appendMessage(durableClone(message));
				if (message.role === "assistant" && message.stopReason !== "pending") {
					await this.durableSession.appendRecord({
						type: "usage",
						id: this.durableSession.idGenerator.next(),
						lane: this.name,
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
			await this.runLifecycleHook("after_response", { operationId: runId, message: durableClone(finalMessage) });
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "completed",
			});
			await this.runLifecycleHook("before_run_end", { operationId: runId, outcome: "completed" });
			this.lifecycle.emit("operation_finished", { operationId: runId, outcome: "completed" });
			this.watchBus.emit({
				type: "run_end",
				lane: this.name,
				runId,
				outcome: "completed",
				leafId: (await this.session.getLeafId()) ?? "",
			});
			return ResultValue.ok({
				runId,
				kind: "completed",
				leafId: (await this.session.getLeafId()) ?? "",
				finalEntryId,
				finalMessage,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "failed",
				error: { code: "run_failed", message },
			});
			this.watchBus.emit({
				type: "run_end",
				lane: this.name,
				runId,
				outcome: "failed",
				leafId: (await this.session.getLeafId()) ?? "",
			});
			return ResultValue.ok({
				kind: "failed",
				runId,
				leafId: (await this.session.getLeafId()) ?? "",
				error: { code: "run_failed", message },
			});
		}
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) return structuredClone(input);
		const expand = (text: string): string => {
			const command = /^(?:\/)(\S+)(?:\s+([\s\S]*))?$/.exec(text);
			const template = command
				? this.resources.promptTemplates?.find((candidate) => candidate.name === command[1])
				: undefined;
			return template === undefined
				? text
				: formatPromptTemplateInvocation(template, command?.[2]?.split(/\s+/u) ?? []);
		};
		if (typeof input !== "string") {
			const message = structuredClone(input);
			if (message.role === "user" && Array.isArray(message.content)) {
				message.content = message.content.map((part) =>
					part.type === "text" ? { ...part, text: expand(part.text) } : part,
				);
			}
			return [message];
		}
		const text = expand(input);
		return [{ role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() }];
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
		const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
		if (open.length > 0) {
			return ResultValue.err(
				new LaneBusy({
					lane: this.name,
					operationId: open[0]!.id,
					operationKind: open[0]!.intent.kind,
					message: "Lane is busy",
				}),
			);
		}
		const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
		const settings = resolveCompactionSettings(this.compactionSettings, this.model.provider, this.model.id);
		const preparation = prepareCompaction(entries, settings);
		if (!preparation.ok) {
			return ResultValue.ok({
				runId: this.durableSession.idGenerator.next(),
				kind: "failed",
				leafId: (await this.session.getLeafId()) ?? "",
				error: { code: preparation.error.code, message: preparation.error.message },
			});
		}
		if (!preparation.value)
			return ResultValue.err(new NothingToCompact({ lane: this.name, message: "Nothing to compact" }));
		const runId = this.durableSession.idGenerator.next();
		const resultEntryId = this.durableSession.idGenerator.next();
		await this.runLifecycleHook("before_compaction", { operationId: runId, model: this.model });
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: this.name,
			sourceLeafId: await this.session.getLeafId(),
			intent: {
				kind: "compaction",
				resultEntryId,
				...(_options?.customInstructions === undefined ? {} : { customInstructions: _options.customInstructions }),
			},
		});
		try {
			await this.park({ kind: "stream_assistant", step: "compaction", attempt: 1 });
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
					lane: this.name,
					runId,
					outcome: result.error.code === "aborted" ? "aborted" : "failed",
					error: { code: result.error.code, message: result.error.message },
				});
				if (result.error.code === "aborted") {
					return ResultValue.ok({
						runId,
						kind: "aborted",
						leafId: (await this.session.getLeafId()) ?? "",
					});
				}
				return ResultValue.ok({
					runId,
					kind: "failed",
					leafId: (await this.session.getLeafId()) ?? "",
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
				this.name,
			);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "completed",
			});
			return ResultValue.ok({
				runId,
				kind: "completed",
				leafId: (await this.session.getLeafId()) ?? "",
				entry,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "failed",
				error: { code: "compaction_failed", message },
			});
			return ResultValue.ok({
				runId,
				kind: "failed",
				leafId: (await this.session.getLeafId()) ?? "",
				error: { code: "compaction_failed", message },
			});
		}
	}
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
		if (open.length > 0) {
			return ResultValue.err(
				new LaneBusy({
					lane: this.name,
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
		const oldLeafId = await this.session.getLeafId();
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
		await this.runLifecycleHook("before_navigation", { operationId: runId, targetId, summarize });
		await this.durableSession.appendRecord({
			type: "operation_started",
			id: runId,
			lane: this.name,
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
								entries: await this.session.findEntriesOnBranch({
									start: oldLeafId,
									order: "oldestFirst",
								}),
								commonAncestorId: null,
							}
						: await collectEntriesForBranchSummary(this.durableSession, oldLeafId, targetId);
				await this.park({ kind: "stream_assistant", step: "branch_summary", attempt: 1 });
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
						lane: this.name,
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
			await this.durableSession.moveLane(this.name, targetId);
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
					this.name,
				);
			}
			if (_options?.label !== undefined && targetId !== null)
				await this.durableSession.setLabel(targetId, _options.label);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
				runId,
				outcome: "completed",
			});
			return ResultValue.ok({ runId, kind: "completed", newLeafId: summaryEntry?.id ?? targetId, summaryEntry });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.durableSession.appendRecord({
				type: "operation_finished",
				id: this.durableSession.idGenerator.next(),
				lane: this.name,
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
				new InvalidRollback({ lane: this.name, message: "Rollback requires a positive turn count" }),
			);
		}
		const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
		if (open.length > 0) {
			return ResultValue.err(
				new LaneBusy({
					lane: this.name,
					operationId: open[0]!.id,
					operationKind: open[0]!.intent.kind,
					message: "Lane is busy",
				}),
			);
		}
		const lanes = await this.durableSession.getLanes();
		if (lanes.some((lane) => lane.lane !== this.name && lane.leafId !== null)) {
			return ResultValue.err(
				new InvalidRollback({ lane: this.name, message: "Rollback requires no active descendant lanes" }),
			);
		}
		const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
		const userEntries = entries.filter(
			(entry): entry is Extract<Entry, { type: "message" }> =>
				entry.type === "message" && entry.message.role === "user",
		);
		if (turns > userEntries.length) {
			return ResultValue.err(
				new InvalidRollback({ lane: this.name, message: "Rollback exceeds surviving user turns" }),
			);
		}
		const target = turns === userEntries.length ? null : userEntries[userEntries.length - turns]!.parentId;
		await this.durableSession.moveLane(this.name, target);
		await this.session.appendCustomEntry("conversation_rollback", { removedTurns: turns, targetId: target });
		return ResultValue.ok({ targetId: target, removedTurns: turns });
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
		const operation = open[0];
		if (!operation) return ResultValue.err(new NothingToResume({ lane: this.name, message: "Nothing to resume" }));
		const suspended = this.suspendedOperations.find((candidate) => candidate.id === operation.id);
		if (suspended && (suspended.missing.models.length > 0 || suspended.missing.tools.length > 0)) {
			return ResultValue.err(
				new MissingIdentities({
					lane: this.name,
					tools: [...suspended.missing.tools],
					models: [...suspended.missing.models],
					message: "Resume requires missing tools or models",
				}),
			);
		}
		await this.durableSession.appendRecord({
			type: "operation_finished",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
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
					leafId: (await this.session.getLeafId()) ?? "",
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
					leafId: (await this.session.getLeafId()) ?? "",
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
				leafId: await this.session.getLeafId(),
				error: { code: result.error.name, message: result.error.message },
			});
		const { runId, ...outcome } = result.value;
		return ResultValue.ok({ operation: "navigation", runId, ...outcome });
	}
	async abort(): Promise<AbortResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		const openRun = (await this.durableSession.findOpenOperations(this.name, { limit: 1 })).find(
			(operation) => operation.intent.kind === "run",
		);
		if (!openRun) return ResultValue.err(new NoActiveOperation({ lane: this.name, message: "No active operation" }));
		const queued = await this.durableSession.findRecords({
			type: "queue_enqueued",
			lane: this.name,
			order: "oldestFirst",
		});
		const cancelled = new Set(
			(await this.durableSession.findRecords({ type: "queue_cancelled", lane: this.name })).map(
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
				lane: this.name,
				runId: openRun.id,
				entryId: item.target.id,
			};
			await this.durableSession.appendRecord(cancellation);
		}
		const requested: NewRecord<AbortRequestedRecord> = {
			type: "abort_requested",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			runId: openRun.id,
		};
		await this.durableSession.appendRecord(requested);
		const finished: NewRecord<OperationFinishedRecord> = {
			type: "operation_finished",
			id: this.durableSession.idGenerator.next(),
			lane: this.name,
			runId: openRun.id,
			outcome: "aborted",
		};
		await this.durableSession.appendRecord(finished);
		this.watchBus.emit({
			type: "run_end",
			lane: this.name,
			runId: openRun.id,
			outcome: "aborted",
			leafId: (await this.session.getLeafId()) ?? "",
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
		const enqueued = (await this.durableSession.findRecords({ type: "queue_enqueued", lane: this.name })).find(
			(record) => record.target.id === entryId,
		);
		if (!enqueued)
			return ResultValue.err(new UnknownQueueItem({ lane: this.name, entryId, message: "Queued item not found" }));
		const cancelled = (await this.durableSession.findRecords({ type: "queue_cancelled", lane: this.name })).some(
			(record) => record.entryId === entryId,
		);
		if (cancelled) return ResultValue.ok({ outcome: "already_cleared" });
		const record: NewRecord<QueueCancelledRecord> =
			enqueued.queue === "nextRun"
				? { type: "queue_cancelled", id: this.durableSession.idGenerator.next(), lane: this.name, entryId }
				: {
						type: "queue_cancelled",
						id: this.durableSession.idGenerator.next(),
						lane: this.name,
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
		const openRun = (await this.durableSession.findOpenOperations(this.name, { limit: 1 })).find(
			(operation) => operation.intent.kind === "run",
		);
		if (requiresRun && !openRun)
			return ResultValue.err(new NoActiveRun({ lane: this.name, message: "No active run" }));
		const message: AgentMessage =
			typeof input === "string"
				? { role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }
				: structuredClone(input);
		const target: ProvisionedEntry = { type: "message", id: this.durableSession.idGenerator.next(), message };
		const record: NewRecord<QueueEnqueuedRecord> =
			queue === "nextRun"
				? { type: "queue_enqueued", id: this.durableSession.idGenerator.next(), lane: this.name, queue, target }
				: {
						type: "queue_enqueued",
						id: this.durableSession.idGenerator.next(),
						lane: this.name,
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
				lane: this.name,
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
			const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
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
		if (this.closed) throw new HarnessClosed();
		return this.manualAction?.info;
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		if (this.closed) throw new HarnessClosed();
		const action = this.manualAction;
		if (action === undefined) return undefined;
		this.manualAction = undefined;
		action.resolve();
		return action.info;
	}
	async runToCompletion(): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		while (true) {
			if (await this.executeAction()) continue;
			const open = await this.durableSession.findOpenOperations(this.name, { limit: 1 });
			if (open.length === 0) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
	}
	async getModel(): Promise<Model<Api>> {
		return this.model;
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
			this.name,
		);
		const settings = resolveCompactionSettings(this.compactionSettings, model.provider, model.id);
		const stats = await this.session.getStats();
		const requestOverhead = await this.estimateProviderRequestOverhead();
		if (shouldCompact(stats.totalTokens + requestOverhead, model.contextWindow ?? 128_000, settings))
			await this.compact();
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		this.thinkingLevel = level;
		await this.durableSession.appendEntry(
			{ type: "thinking_level_change", id: this.durableSession.idGenerator.next(), thinkingLevel: level },
			this.name,
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
			this.name,
		);
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		const snapshot = await this.laneSnapshot(this.name);
		return this.watchBus.watch(() => snapshot);
	}
	async getQueueSnapshot(): Promise<LaneSnapshot["queues"]> {
		return (await this.laneSnapshot(this.name)).queues;
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		if (this.closed) throw new HarnessClosed();
		const lane = (await this.durableSession.getLanes()).find((candidate) => candidate.lane === name);
		if (!lane) return undefined;
		if (lane.lane === this.name) return this;
		const result = await AgentHarness.create({ ...this.harnessOptions, lane: lane.lane });
		return result.harness;
	}
	async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
		if (this.closed) return ResultValue.err(new Closed({ message: "AgentHarness is closed" }));
		try {
			await this.durableSession.createLane(name, at);
			const result = await AgentHarness.create({ ...this.harnessOptions, lane: name });
			return ResultValue.ok(result.harness);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			const code = error.code;
			if (code === "already_exists")
				return ResultValue.err(new LaneExists({ lane: name, message: `Lane already exists: ${name}` }));
			if (code === "not_found")
				return ResultValue.err(
					new UnknownTarget({ targetId: at ?? "", message: `Unknown lane target: ${at ?? ""}` }),
				);
			return ResultValue.err(
				new InvalidLane({ lane: name, reason: String(code), message: `Invalid lane: ${name}` }),
			);
		}
	}
	async lanes(): Promise<LaneInfo[]> {
		if (this.closed) throw new HarnessClosed();
		const lanes = await this.durableSession.getLanes();
		return Promise.all(
			lanes.map(async (lane) => {
				const operation = (await this.durableSession.findOpenOperations(lane.lane, { limit: 1 }))[0];
				return {
					name: lane.lane,
					leafId: lane.leafId,
					operation: operation
						? {
								id: operation.id,
								kind: operation.intent.kind,
								status: this.suspendedOperations.some((item) => item.id === operation.id)
									? "suspended"
									: "running",
							}
						: null,
				};
			}),
		);
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
			this.name,
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
		await this.durableSession.appendEntry(
			{
				type: "custom",
				customType: "retry_policy_change",
				id: this.durableSession.idGenerator.next(),
				data: durableClone(policy),
			},
			this.name,
		);
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return resolveCompactionSettings(this.compactionSettings, this.model.provider, this.model.id);
	}
	async getCompactionPolicySource(): Promise<CompactionPolicySource> {
		const override = this.compactionSettings.modelOverrides?.[`${this.model.provider}/${this.model.id}`];
		if (override === undefined) return "global";
		const overriddenFields = [override.enabled, override.reserveTokens, override.keepRecentTokens].filter(
			(value) => value !== undefined,
		).length;
		return overriddenFields === 3 ? "model" : "mixed";
	}
	async setCompactionEnabled(enabled: boolean): Promise<void> {
		const modelKey = `${this.model.provider}/${this.model.id}`;
		const override = this.compactionSettings.modelOverrides?.[modelKey];
		const settings: CompactionSettings =
			override?.enabled === undefined
				? { ...this.compactionSettings, enabled }
				: {
						...this.compactionSettings,
						modelOverrides: {
							...this.compactionSettings.modelOverrides,
							[modelKey]: { ...override, enabled },
						},
					};
		await this.setCompactionSettings(settings);
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
		await this.durableSession.appendEntry(
			{
				type: "custom",
				customType: "compaction_settings_change",
				id: this.durableSession.idGenerator.next(),
				data: durableClone(settings),
			},
			this.name,
		);
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
		await this.durableSession.appendEntry(
			{ type: "custom", customType: "steering_mode_change", id: this.durableSession.idGenerator.next(), data: mode },
			this.name,
		);
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
		await this.durableSession.appendEntry(
			{
				type: "custom",
				customType: "follow_up_mode_change",
				id: this.durableSession.idGenerator.next(),
				data: mode,
			},
			this.name,
		);
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		const snapshot = await this.sessionSnapshot();
		return this.watchBus.watch(() => snapshot);
	}
	async close(): Promise<void> {
		this.manualAction?.reject(new HarnessClosed());
		this.manualAction = undefined;
		this.closed = true;
	}

	private async park(info: ActionInfo): Promise<void> {
		if (this.driveMode !== "manual") return;
		if (this.manualAction !== undefined) throw new Error("AgentHarness manual drive already has a parked action");
		await new Promise<void>((resolve, reject) => {
			this.manualAction = { info, resolve, reject };
		});
	}

	private async runLifecycleHook(name: HookName, event: unknown): Promise<void> {
		if (!this.lifecycle.hasHook(name)) return;
		await this.park({ kind: "hook", name });
		await this.lifecycle.runHook(name, event);
	}

	private async laneSnapshot(lane: string): Promise<LaneSnapshot> {
		const laneSession = this.durableSession.view(lane);
		const [leafId, transcript, open, queued, cancelled] = await Promise.all([
			laneSession.getLeafId(),
			laneSession.findEntriesOnBranch({ order: "oldestFirst" }),
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
