import type {
	AgentHarness,
	AgentMessage,
	Entry,
	GoalContinuationScheduler,
	GoalManager,
	ItemCompletedEvent,
	ToolCompletedEvent,
	ToolStartedEvent,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Message, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	AgentSummary,
	CommandNameV2,
	CommandV2,
	CompactionPolicy,
	DiagnosticsSnapshot,
	InstructionProfileSummary,
	ModelMetadata,
	OperationAccepted,
	OperationSummary,
	PlanSnapshot,
	PromptContent,
	SessionMetadataV2,
	SessionPhaseV2,
	SessionSnapshotV2,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import type {
	ForensicRecorder,
	PiSessionRuntimeEventV2,
	V2InputRegistry,
	V2UsageLedger,
} from "@earendil-works/pi-server";
import { normalizeGeneratedName } from "@earendil-works/pi-session-naming";
import type { ServerRuntimeExtensionHookResult, ServerRuntimeExtensionHost } from "./extension-host.ts";

export { normalizeGeneratedName } from "@earendil-works/pi-session-naming";

const AGENT_COMPLETION = "agent_completion";
const AGENT_COMPLETION_CONSUMED = "agent_completion_consumed";
const MAX_AGENT_COMPLETION_RECORDS = 32;
const MAX_AGENT_COMPLETION_CHARACTERS = 16_000;

interface AgentCompletionRecord {
	readonly entryId: string;
	readonly agentId: string;
	readonly path: string;
	readonly taskName: string;
	readonly state: string;
	readonly role?: string;
	readonly model?: { readonly provider: string; readonly id: string };
}

type HarnessRuntimeEvent = ItemCompletedEvent | ToolStartedEvent | ToolCompletedEvent;

function readAgentCompletion(entry: Entry): AgentCompletionRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== AGENT_COMPLETION) return undefined;
	if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (
		typeof data.agentId !== "string" ||
		typeof data.path !== "string" ||
		typeof data.taskName !== "string" ||
		typeof data.state !== "string"
	)
		return undefined;
	const model =
		typeof data.model === "object" && data.model !== null && !Array.isArray(data.model)
			? (data.model as Record<string, unknown>)
			: undefined;
	return {
		entryId: entry.id,
		agentId: data.agentId,
		path: data.path,
		taskName: data.taskName,
		state: data.state,
		...(typeof data.role === "string" ? { role: data.role } : {}),
		...(model && typeof model.provider === "string" && typeof model.id === "string"
			? { model: { provider: model.provider, id: model.id } }
			: {}),
	};
}

function consumedCompletionId(entry: Entry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== AGENT_COMPLETION_CONSUMED) return undefined;
	if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) return undefined;
	const entryId = (entry.data as Record<string, unknown>).entryId;
	return typeof entryId === "string" ? entryId : undefined;
}

function appendAgentCompletions(input: AgentMessage, completions: readonly AgentCompletionRecord[]): AgentMessage {
	if (completions.length === 0 || input.role !== "user") return input;
	const text = completions
		.map(
			(completion) =>
				`- ${completion.path} (${completion.state})${completion.role ? ` role=${completion.role}` : ""}${completion.model ? ` [${completion.model.provider}/${completion.model.id}]` : ""}`,
		)
		.join("\n");
	const summary = `[child agent completions]\n${text}`;
	if (typeof input.content === "string") return { ...input, content: `${summary}\n\n${input.content}` };
	return { ...input, content: [{ type: "text", text: summary }, ...input.content] };
}

export interface CodingAgentV2SessionDefinition {
	metadata: SessionMetadataV2;
	/** Stable server-owned agent/thread path rendered by remote clients. */
	agentPath?: string;
	harness: AgentHarness;
	/** Called before the runtime closes the harness so durable callbacks can preserve recoverable work. */
	onDispose?: () => void;
	recoveryState?: "clean" | "recovered" | "needsResolution" | "degraded";
	goals?: GoalManager;
	goalContinuation?: GoalContinuationScheduler;
	extensionHost?: ServerRuntimeExtensionHost;
	inputs?: V2InputRegistry;
	usage?: V2UsageLedger;
	forensicRecorder?: ForensicRecorder;
	instructionProfile?: () => Promise<InstructionProfileSummary | undefined>;
	pluginSetHash?: () => Promise<string>;
	agents?: () => Promise<readonly AgentSummary[]>;
	abortChildren?: () => Promise<void>;
	plan?: () => Promise<PlanSnapshot | undefined>;
	diagnostics?: () => Promise<DiagnosticsSnapshot>;
	queues?: () => Promise<{
		steer: readonly QueuedPrompt[];
		followUp: readonly QueuedPrompt[];
	}>;
}

/** A queued provider message plus its server-owned, snapshot-safe content references. */
export interface QueuedPrompt {
	readonly entryId: string;
	readonly message: AgentMessage;
	readonly content?: readonly PromptContent[];
}

export interface CodingAgentV2Service {
	listSessions(): Promise<SessionMetadataV2[]>;
	listModels(): Promise<ModelMetadata[]>;
	openSession(sessionId: string): Promise<CodingAgentV2Runtime>;
	createSession?(options: Record<string, unknown>): Promise<{ sessionId: string; runtime: CodingAgentV2Runtime }>;
	forkSession?(
		sourceSessionId: string,
		options: Record<string, unknown>,
	): Promise<{ sessionId: string; runtime: CodingAgentV2Runtime }>;
	deleteSession?(sessionId: string): Promise<void>;
}

export interface CodingAgentV2ServiceOptions {
	/** Provider-local fast model used only for side-band automatic naming. */
	fastModel?: Model<string>;
	/** Resolve a provider-local role without changing the session's active model. */
	fastModelResolver?: (model: Model<string>) => Model<string> | undefined;
	/** Durable owner creates a fully initialized session definition. */
	createSession?: (options: Record<string, unknown>) => Promise<CodingAgentV2SessionDefinition>;
	/** Durable owner forks a session and returns its initialized definition. */
	forkSession?: (sourceSessionId: string, options: Record<string, unknown>) => Promise<CodingAgentV2SessionDefinition>;
	/** Durable owner removes a session after the adapter disposes its runtime. */
	deleteSession?: (sessionId: string) => Promise<void>;
	/** Durable catalog used when definitions are opened lazily. */
	listSessions?: () => Promise<SessionMetadataV2[]>;
	/** Durable owner opens a definition for a catalogued session. */
	openSession?: (sessionId: string) => Promise<CodingAgentV2SessionDefinition>;
	/** Catalog entries known before their harness is opened. */
	initialSessions?: readonly SessionMetadataV2[];
}

export interface CodingAgentV2SessionStore {
	list(): Promise<SessionMetadataV2[]>;
	open(sessionId: string): Promise<CodingAgentV2SessionDefinition>;
	create(options: Record<string, unknown>): Promise<CodingAgentV2SessionDefinition>;
	fork?(sourceSessionId: string, options: Record<string, unknown>): Promise<CodingAgentV2SessionDefinition>;
	delete(sessionId: string): Promise<void>;
}

export interface CodingAgentV2Runtime {
	snapshot(): Promise<SessionSnapshotV2>;
	onEvent?(listener: (event: PiSessionRuntimeEventV2) => void): () => void;
	cancelQueued(entryId: string): Promise<void>;
	accept(operationId: string, command?: CommandV2): Promise<OperationAccepted>;
	run(operationId: string, command: CommandV2): Promise<void>;
	/** Attribute descendant provider usage to this session's durable goal. */
	recordGoalUsage?(tokens: number): Promise<void>;
	/** Optional append-only state seam for server-owned registries. */
	appendCustomEntry?(customType: string, data?: unknown): Promise<string>;
	/** Optional read seam for reconstructing server-owned registry projections. */
	readCustomEntries?(customType: string): Promise<readonly Entry[]>;
	dispose(): Promise<void>;
}

function modelMetadata(model: Model<string>): ModelMetadata {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
		supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		authenticated: true,
	};
}

type PromptPart = { type: "text"; text: string } | ImageContent;

function queueContent(message: AgentMessage, references?: readonly PromptContent[]): PromptContent[] {
	if (references !== undefined) return [...references];
	if (message.role !== "user") return [{ type: "text", text: `[${message.role} message]` }];
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((part) =>
		part.type === "text" ? { type: "text", text: part.text } : { type: "text", text: "[image]" },
	);
}

function commandInput(command: CommandV2): AgentMessage {
	const payload = command.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload))
		return { role: "user", content: [{ type: "text", text: "" }], timestamp: Date.now() };
	const record = payload as Record<string, unknown>;
	if (record.content === undefined)
		return {
			role: "user",
			content: [{ type: "text", text: typeof record.text === "string" ? record.text : "" }],
			timestamp: Date.now(),
		};
	if (!Array.isArray(record.content) || record.content.length === 0)
		throw new Error("turn content must be a non-empty array");
	const content: PromptPart[] = record.content.map((part, index) => {
		if (typeof part !== "object" || part === null || Array.isArray(part))
			throw new Error(`turn content item ${index} must be an object`);
		const item = part as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
		if (
			item.type === "image" &&
			typeof item.data === "string" &&
			typeof item.mimeType === "string" &&
			item.mimeType.startsWith("image/")
		)
			return { type: "image", data: item.data, mimeType: item.mimeType };
		throw new Error(`turn content item ${index} must be text or resolved image data`);
	});
	return { role: "user", content, timestamp: Date.now() };
}

function commandPayload(command: CommandV2): Record<string, unknown> {
	return typeof command.payload === "object" && command.payload !== null && !Array.isArray(command.payload)
		? (command.payload as Record<string, unknown>)
		: {};
}

function assertPromptCapabilities(model: Model<Api>, input: AgentMessage): void {
	if (input.role !== "user") return;
	if (!Array.isArray(input.content)) return;
	const hasImage = input.content.some((part) => part.type === "image");
	if (hasImage && !model.input.includes("image"))
		throw new Error(`Model ${model.provider}/${model.id} does not support image input`);
}

function transcriptItem(entry: Entry): TranscriptItem | undefined {
	if (entry.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content))
		return undefined;
	const timestamp = entry.message.timestamp ?? entry.timestamp;
	if (entry.message.role === "user") {
		return { id: entry.id, role: "user", content: entry.message.content, timestamp };
	}
	if (entry.message.role === "assistant") {
		const content: unknown[] = [];
		for (const item of entry.message.content) {
			if (item.type === "text") content.push({ type: "text", text: item.text });
			else if (item.type === "thinking")
				content.push({
					type: "thinking",
					thinking: item.thinking,
					...(item.redacted === undefined ? {} : { redacted: item.redacted }),
				});
			else if (item.type === "toolCall")
				content.push({ type: "toolCall", toolCallId: item.id, toolName: item.name, input: item.arguments });
		}
		const status =
			entry.message.stopReason === "error"
				? "error"
				: entry.message.stopReason === "aborted"
					? "aborted"
					: "complete";
		return {
			id: entry.id,
			role: "assistant",
			content,
			model: { provider: entry.message.provider, id: entry.message.model },
			...(entry.message.responseModel === undefined ? {} : { responseModel: entry.message.responseModel }),
			usage: entry.message.usage,
			timestamp,
			status,
			...(status === "complete" ? { stopReason: entry.message.stopReason } : {}),
			...(entry.message.errorMessage === undefined ? {} : { errorMessage: entry.message.errorMessage }),
		} as TranscriptItem;
	}
	if (entry.message.role === "toolResult") {
		const content = entry.message.content.filter(
			(item): item is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } =>
				item.type === "text" || item.type === "image",
		);
		return {
			id: entry.id,
			role: "tool",
			toolCallId: entry.message.toolCallId,
			toolName: entry.message.toolName,
			input: {},
			content,
			...(entry.message.details === undefined ? {} : { details: entry.message.details }),
			...(entry.message.usage === undefined ? {} : { usage: entry.message.usage }),
			timestamp,
			status: entry.message.isError ? "error" : "complete",
			isError: entry.message.isError,
		} as TranscriptItem;
	}
	return undefined;
}

class CodingAgentV2RuntimeImpl implements CodingAgentV2Runtime {
	private revision = 1;
	private eventSeq = 1;
	private readonly definition: CodingAgentV2SessionDefinition;
	private readonly models: Models;
	private model: Model<string>;
	private nameRevision = 0;
	private autoName = true;
	private readonly queuedTurnOperations = new Set<string>();
	private sessionName: string | undefined;
	private nameSource: "explicit" | "generated" | "derived" | undefined;
	private phase: SessionPhaseV2 = "idle";
	private activeOperation: OperationSummary | undefined;
	private recoveryState: "clean" | "recovered" | "needsResolution" | "degraded";
	private activeOperationId: string | undefined;
	private readonly eventListeners = new Set<(event: PiSessionRuntimeEventV2) => void>();
	private readonly unsubscribeHarnessEvents: readonly (() => void)[];

	private readonly fastModel: Model<string> | undefined;
	private readonly fastModelResolver: ((model: Model<string>) => Model<string> | undefined) | undefined;
	private autoNameLoaded = false;
	private nameStateLoaded = false;
	private nameGeneration: Promise<void> | undefined;

	constructor(
		definition: CodingAgentV2SessionDefinition,
		models: Models,
		model: Model<string>,
		options?: CodingAgentV2ServiceOptions,
	) {
		this.definition = definition;
		this.models = models;
		this.model = model;
		this.sessionName = definition.metadata.sessionName;
		this.nameSource = definition.metadata.nameSource;
		this.recoveryState = definition.recoveryState ?? "clean";
		this.unsubscribeHarnessEvents = [
			definition.harness.events.on("item_completed", (event) =>
				this.emitRuntimeEvent(
					"item_completed",
					event as unknown as Extract<HarnessRuntimeEvent, { type: "item_completed" }>,
				),
			),
			definition.harness.events.on("tool_started", (event) =>
				this.emitRuntimeEvent(
					"tool_started",
					event as unknown as Extract<HarnessRuntimeEvent, { type: "tool_started" }>,
				),
			),
			definition.harness.events.on("tool_completed", (event) =>
				this.emitRuntimeEvent(
					"tool_completed",
					event as unknown as Extract<HarnessRuntimeEvent, { type: "tool_completed" }>,
				),
			),
		];
		this.fastModel = options?.fastModel;
		this.fastModelResolver = options?.fastModelResolver;
	}

	onEvent(listener: (event: PiSessionRuntimeEventV2) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	private emitRuntimeEvent(
		eventType: "item_completed" | "tool_started" | "tool_completed",
		event: HarnessRuntimeEvent,
	): void {
		if (this.activeOperationId === undefined) return;
		const payload =
			event.type === "item_completed"
				? { role: event.role }
				: event.type === "tool_started"
					? { toolCallId: event.toolCallId, toolName: event.toolName }
					: { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError };
		const mapped: PiSessionRuntimeEventV2 = {
			sessionId: this.definition.metadata.id,
			event: eventType,
			operationId: this.activeOperationId,
			payload,
		};
		for (const listener of this.eventListeners) listener(mapped);
		void this.definition.extensionHost?.dispatchRuntimeEvent(mapped);
	}

	private async generateName(operationId: string): Promise<void> {
		const resolvedFastModel = this.fastModelResolver?.(this.model);
		const namingModel =
			(resolvedFastModel?.provider === this.model.provider ? resolvedFastModel : undefined) ??
			(this.fastModel?.provider === this.model.provider ? this.fastModel : undefined) ??
			this.model;
		const initialSource = this.nameSource;
		if (initialSource === "explicit") return;
		const initialRevision = this.nameRevision;
		const initialName = await this.definition.harness.session.getName();
		if (initialName !== undefined) return;
		const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const transcript = entries
			.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
			.slice(-48)
			.map((entry) => {
				if (!("content" in entry.message) || !Array.isArray(entry.message.content)) return undefined;
				const text = entry.message.content
					.filter(
						(content): content is { type: "text"; text: string } =>
							typeof content === "object" &&
							content !== null &&
							content.type === "text" &&
							typeof content.text === "string",
					)
					.map((content) => content.text)
					.join(" ")
					.trim();
				return text.length === 0 ? undefined : `${entry.message.role}: ${text}`;
			})
			.filter((line): line is string => line !== undefined)
			.join("\n")
			.slice(-6000);
		if (transcript.length === 0) return;
		const response = await this.models.completeSimple(namingModel, {
			messages: [
				{
					role: "user",
					content: `Create a concise session title (3-8 words). Return only the title.\n\n${transcript}`,
					timestamp: Date.now(),
				},
			] satisfies Message[],
		});
		const generated = normalizeGeneratedName(
			response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join(" "),
			{ secretFallback: true },
		);
		if (!generated || this.nameRevision !== initialRevision || this.nameSource !== initialSource) return;
		if ((await this.definition.harness.session.getName()) !== initialName) return;
		await this.definition.harness.session.setName(generated);
		await this.definition.harness.recordUsage(
			{
				input: response.usage.input,
				output: response.usage.output,
				cacheRead: response.usage.cacheRead,
				cacheWrite: response.usage.cacheWrite,
				totalTokens: response.usage.totalTokens,
				cost: { ...response.usage.cost },
				...(response.usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: response.usage.cacheWrite1h }),
				...(response.usage.reasoning === undefined ? {} : { reasoning: response.usage.reasoning }),
			},
			{ entryId: entries.at(-1)?.id, details: "purpose:sessionName" },
		);
		await this.definition.usage?.record({
			responseId: response.responseId ?? `${operationId}:sessionName`,
			sessionId: this.definition.metadata.id,
			agentId: this.definition.metadata.id,
			operationId,
			turnId: operationId,
			purpose: "sessionName",
			provider: response.provider,
			model: response.model,
			input: response.usage.input,
			output: response.usage.output,
			cacheRead: response.usage.cacheRead,
			cacheWrite: response.usage.cacheWrite,
			...(response.usage.reasoning === undefined ? {} : { reasoning: response.usage.reasoning }),
			pricing: "providerReported",
			costUsd: response.usage.cost.total,
			createdAt: response.timestamp ?? Date.now(),
		});
		this.sessionName = generated;
		this.nameSource = "generated";
		this.nameRevision += 1;
		await this.persistNameState();
	}

	private async readPendingAgentCompletions(): Promise<AgentCompletionRecord[]> {
		const entries = await this.definition.harness.session.findEntries();
		const consumed = new Set(
			entries.map(consumedCompletionId).filter((entryId): entryId is string => entryId !== undefined),
		);
		const pending: AgentCompletionRecord[] = [];
		let characters = 0;
		for (const entry of entries) {
			const completion = readAgentCompletion(entry);
			if (completion === undefined || consumed.has(completion.entryId)) continue;
			const line = `${completion.path} ${completion.state} ${completion.taskName}`;
			if (
				pending.length >= MAX_AGENT_COMPLETION_RECORDS ||
				characters + line.length > MAX_AGENT_COMPLETION_CHARACTERS
			)
				break;
			pending.push(completion);
			characters += line.length;
		}
		return pending.reverse();
	}

	private async markAgentCompletionsConsumed(completions: readonly AgentCompletionRecord[]): Promise<void> {
		for (const completion of completions)
			await this.definition.harness.session.appendCustomEntry(AGENT_COMPLETION_CONSUMED, {
				version: 1,
				entryId: completion.entryId,
			});
		for (const completion of completions)
			void this.definition.forensicRecorder
				?.record({
					kind: "agent_completion_delivered",
					sessionId: this.definition.metadata.id,
					agentId: completion.agentId,
					payload: { path: completion.path, state: completion.state, taskName: completion.taskName },
				})
				.catch(() => undefined);
	}

	private async ensureAutoNameLoaded(): Promise<void> {
		if (this.autoNameLoaded) return;
		const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "newestFirst" });
		const setting = entries.find(
			(entry) =>
				entry.type === "custom" && entry.customType === "auto_name_setting" && typeof entry.data === "boolean",
		);
		if (setting?.type === "custom" && typeof setting.data === "boolean") this.autoName = setting.data;
		this.autoNameLoaded = true;
	}

	private async ensureNameStateLoaded(): Promise<void> {
		if (this.nameStateLoaded) return;
		const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "newestFirst" });
		const state = entries.find(
			(entry) =>
				entry.type === "custom" && entry.customType === "session_name_state" && typeof entry.data === "object",
		);
		if (state?.type === "custom" && typeof state.data === "object" && state.data !== null) {
			const value = state.data as { name?: unknown; source?: unknown; revision?: unknown };
			if (typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) {
				this.nameRevision = value.revision;
				this.sessionName = typeof value.name === "string" ? value.name : undefined;
				this.nameSource =
					value.source === "explicit" || value.source === "generated" || value.source === "derived"
						? value.source
						: undefined;
			}
		}
		this.nameStateLoaded = true;
	}

	private async persistNameState(): Promise<void> {
		await this.definition.harness.session.appendCustomEntry("session_name_state", {
			name: this.sessionName ?? null,
			source: this.nameSource ?? null,
			revision: this.nameRevision,
		});
	}

	private scheduleNameGeneration(operationId: string): void {
		if (this.nameGeneration !== undefined) return;
		this.nameGeneration = this.generateName(operationId)
			.catch(() => undefined)
			.finally(() => {
				this.nameGeneration = undefined;
			});
	}

	private async recordCurrentGoalUsage(beforeTokens: number): Promise<void> {
		if (!this.definition.goals) return;
		if (!(await this.definition.goals.read())) return;
		const afterTokens = (await this.definition.harness.session.getStats()).totalTokens;
		const delta = Math.max(0, afterTokens - beforeTokens);
		if (delta > 0) await this.definition.goals.recordUsage(delta);
	}

	private recordExtensionHookResults(
		operationId: string,
		hook: "accepted" | "terminal",
		results: readonly ServerRuntimeExtensionHookResult[] | undefined,
	): void {
		if (results === undefined || this.definition.forensicRecorder === undefined) return;
		for (const result of results) {
			const reason = result.reason instanceof Error ? result.reason.message : result.reason;
			this.emitPluginDiagnostic(operationId, hook, result, reason);
			void this.definition.forensicRecorder
				.record({
					kind: "server_extension_hook",
					severity: result.status === "fulfilled" ? "info" : "warn",
					outcome: result.status === "fulfilled" ? "ok" : "error",
					sessionId: this.definition.metadata.id,
					operationId,
					payload: {
						hook,
						extensionId: result.extensionId,
						status: result.status,
						...(reason === undefined ? {} : { reason: String(reason).slice(0, 512) }),
					},
				})
				.catch(() => undefined);
		}
	}

	private emitPluginDiagnostic(
		operationId: string,
		hook: "accepted" | "terminal",
		result: ServerRuntimeExtensionHookResult,
		reason: unknown,
	): void {
		const payload = {
			hook,
			extensionId: result.extensionId,
			status: result.status,
			...(reason === undefined ? {} : { reason: String(reason).slice(0, 512) }),
		};
		const event: PiSessionRuntimeEventV2 = {
			sessionId: this.definition.metadata.id,
			event: "plugin_diagnostic",
			operationId,
			payload,
		};
		for (const listener of this.eventListeners) listener(event);
		void this.definition.extensionHost?.dispatchRuntimeEvent(event);
	}

	private async recordInstructionProfile(operationId: string): Promise<void> {
		if (this.definition.forensicRecorder === undefined || this.definition.instructionProfile === undefined) return;
		try {
			const profile = await this.definition.instructionProfile();
			if (profile === undefined) return;
			await this.definition.forensicRecorder.record({
				kind: "model_instruction_profile",
				severity: "info",
				outcome: "ok",
				sessionId: this.definition.metadata.id,
				operationId,
				payload: {
					id: profile.id,
					source: profile.source,
					contentHash: profile.contentHash,
					...(profile.byteLength === undefined ? {} : { byteLength: profile.byteLength }),
					...(profile.estimatedTokens === undefined ? {} : { estimatedTokens: profile.estimatedTokens }),
				},
			});
		} catch {
			// Profile diagnostics are metadata-only and must not change operation semantics.
		}
	}

	private async compactionPolicySnapshot(): Promise<CompactionPolicy> {
		const [model, settings, source] = await Promise.all([
			this.definition.harness.getModel(),
			this.definition.harness.getCompactionSettings(),
			this.definition.harness.getCompactionPolicySource(),
		]);
		const contextWindow = Math.max(1, model.contextWindow);
		const reserveTokens = Math.max(0, settings.reserveTokens);
		return {
			enabled: settings.enabled,
			contextWindow,
			reserveTokens,
			keepRecentTokens: Math.max(0, settings.keepRecentTokens),
			triggerTokens: Math.max(0, contextWindow - reserveTokens),
			source,
		};
	}

	private async recordUsageLedger(operationId: string, beforeEntryIds: ReadonlySet<string>): Promise<void> {
		const ledger = this.definition.usage;
		if (!ledger) return;
		const goalId = (await this.definition.goals?.read())?.id;
		const currentModel = await this.definition.harness.getModel();
		const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		for (const entry of entries) {
			if (entry.type === "compaction") {
				if (beforeEntryIds.has(entry.id) || entry.usage === undefined) continue;
				await ledger.record({
					responseId: `${operationId}:compaction:${entry.id}`,
					sessionId: this.definition.metadata.id,
					agentId: this.definition.metadata.id,
					operationId,
					turnId: operationId,
					...(goalId === undefined ? {} : { goalId }),
					purpose: "compaction",
					provider: currentModel.provider,
					model: currentModel.id,
					input: entry.usage.input,
					output: entry.usage.output,
					cacheRead: entry.usage.cacheRead,
					cacheWrite: entry.usage.cacheWrite,
					...(entry.usage.reasoning === undefined ? {} : { reasoning: entry.usage.reasoning }),
					pricing: "providerReported",
					costUsd: entry.usage.cost.total,
					createdAt: entry.timestamp,
				});
				continue;
			}
			if (
				entry.type !== "message" ||
				beforeEntryIds.has(entry.id) ||
				entry.message.role !== "assistant" ||
				entry.message.usage === undefined
			)
				continue;
			const usage = entry.message.usage;
			await ledger.record({
				responseId: entry.message.responseId ?? entry.id,
				sessionId: this.definition.metadata.id,
				agentId: this.definition.metadata.id,
				operationId,
				turnId: operationId,
				...(goalId === undefined ? {} : { goalId }),
				purpose: "agent",
				provider: entry.message.provider,
				model: entry.message.model,
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
				pricing: "providerReported",
				costUsd: usage.cost.total,
				createdAt: entry.message.timestamp ?? entry.timestamp,
			});
		}
	}

	async snapshot(): Promise<SessionSnapshotV2> {
		await this.nameGeneration;
		await this.ensureAutoNameLoaded();
		await this.ensureNameStateLoaded();
		const [
			leafId,
			thinkingLevel,
			steeringMode,
			followUpMode,
			retryPolicy,
			compactionSource,
			stats,
			compaction,
			entries,
			pendingInputRequestId,
			usageAggregate,
		] = await Promise.all([
			this.definition.harness.getLeafId(),
			this.definition.harness.getThinkingLevel(),
			this.definition.harness.getSteeringMode(),
			this.definition.harness.getFollowUpMode(),
			this.definition.harness.getRetryPolicy(),
			this.definition.harness.getCompactionPolicySource(),
			this.definition.harness.session.getStats(),
			this.definition.harness.getCompactionSettings(),
			this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }),
			this.definition.inputs?.pendingForSession(this.definition.metadata.id),
			this.definition.usage?.aggregate({ sessionId: this.definition.metadata.id }),
		]);
		void leafId;
		const [goal, persistedName, instructionProfile, pluginSetHash, agents, plan, diagnostics] = await Promise.all([
			this.definition.goals?.read(),
			this.definition.harness.session.getName(),
			this.definition.instructionProfile?.(),
			this.definition.pluginSetHash?.(),
			this.definition.agents?.(),
			this.definition.plan?.(),
			this.definition.diagnostics?.(),
		]);
		const queues = await this.definition.queues?.();
		const effectiveName = persistedName ?? this.sessionName;
		const cacheRead = usageAggregate?.cacheRead ?? Math.max(0, stats.cachedTokens);
		const input = usageAggregate?.input ?? Math.max(0, stats.uncachedTokens);
		const output =
			usageAggregate?.output ?? Math.max(0, stats.totalTokens - stats.cachedTokens - stats.uncachedTokens);
		const costUsd =
			usageAggregate?.costUsd ?? (usageAggregate === undefined && stats.costTotal > 0 ? stats.costTotal : undefined);
		const contextWindow = Math.max(1, this.model.contextWindow);
		const reserveTokens = Math.max(0, compaction.reserveTokens);
		const transcript = entries
			.flatMap((entry) => {
				const item = transcriptItem(entry);
				return item === undefined ? [] : [item];
			})
			.slice(-200);
		return {
			id: this.definition.metadata.id,
			agentPath: this.definition.agentPath ?? "/root",
			...(effectiveName === undefined
				? {}
				: { name: effectiveName, ...(this.nameSource === undefined ? {} : { nameSource: this.nameSource }) }),
			nameRevision: this.nameRevision,
			revision: this.revision,
			eventSeq: this.eventSeq,
			phase: pendingInputRequestId === undefined ? this.phase : "awaitingInput",
			...(this.activeOperation === undefined ? {} : { activeOperation: { ...this.activeOperation } }),
			model: { provider: this.model.provider, id: this.model.id },
			thinkingLevel,
			transcript,
			queues: {
				steer: (queues?.steer ?? []).map((item) => ({
					id: item.entryId,
					content: queueContent(item.message, item.content),
					createdAt: item.message.timestamp ?? 0,
				})),
				followUp: (queues?.followUp ?? []).map((item) => ({
					id: item.entryId,
					content: queueContent(item.message, item.content),
					createdAt: item.message.timestamp ?? 0,
				})),
			},
			steeringMode,
			followUpMode,
			autoRetryEnabled: retryPolicy.enabled,
			...(goal === undefined ? {} : { goal }),
			...(plan === undefined ? {} : { plan }),
			agents: agents === undefined ? [] : [...agents],
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: usageAggregate?.cacheWrite ?? 0,
				imageUnits: usageAggregate?.imageUnits ?? 0,
				...(costUsd === undefined ? {} : { costUsd }),
				pricingState: usageAggregate?.pricingState ?? "known",
			},
			context: {
				inputTokens: Math.max(0, stats.totalTokens),
				contextWindow,
				usedPercentage: Math.min(100, (Math.max(0, stats.totalTokens) / contextWindow) * 100),
			},
			...(instructionProfile === undefined ? {} : { instructionProfile }),
			compactionPolicy: {
				enabled: compaction.enabled,
				contextWindow,
				reserveTokens,
				keepRecentTokens: Math.max(0, compaction.keepRecentTokens),
				triggerTokens: Math.max(0, contextWindow - reserveTokens),
				source: compactionSource,
			},
			pluginSetHash: pluginSetHash ?? "plugins-empty",
			diagnostics: diagnostics ?? { capture: "metadata", degraded: false, lastCriticalEventSeq: 0 },
			persistence: { schemaVersion: 1, recoveryState: this.recoveryState },
			createdAt: this.definition.metadata.createdAt,
			updatedAt: this.definition.metadata.updatedAt ?? this.definition.metadata.createdAt,
		};
	}

	async accept(_operationId: string, command?: CommandV2): Promise<OperationAccepted> {
		const policy = await this.compactionPolicySnapshot();
		if (
			(command?.command === "turn/followUp" || command?.command === "turn/steer") &&
			(this.activeOperation?.state === "accepted" || this.activeOperation?.state === "running")
		) {
			this.revision += 1;
			this.eventSeq += 1;
			this.queuedTurnOperations.add(_operationId);
			return {
				operationId: _operationId,
				sessionRevision: this.revision,
				eventSeq: this.eventSeq,
				model: { provider: this.model.provider, id: this.model.id },
				compactionPolicy: policy,
			};
		}
		this.revision += 1;
		this.eventSeq += 1;
		this.phase = "turn";
		this.activeOperation = {
			operationId: _operationId,
			kind: "pending",
			state: "accepted",
			acceptedSeq: this.eventSeq,
			model: { provider: this.model.provider, id: this.model.id },
			compactionPolicy: policy,
		};
		return {
			operationId: _operationId,
			sessionRevision: this.revision,
			eventSeq: this.eventSeq,
			model: { provider: this.model.provider, id: this.model.id },
			compactionPolicy: policy,
		};
	}

	async rejectAccepted(_operationId: string, _error: string): Promise<void> {
		this.revision += 1;
		this.eventSeq += 1;
		this.phase = "failed";
		this.recoveryState = "degraded";
		this.activeOperation = {
			...(this.activeOperation ?? {
				operationId: _operationId,
				kind: "pending" as const,
				acceptedSeq: this.eventSeq - 1,
			}),
			operationId: _operationId,
			state: "failed",
			terminalSeq: this.eventSeq,
		};
	}

	async run(_operationId: string, command: CommandV2): Promise<void> {
		await this.ensureAutoNameLoaded();
		await this.ensureNameStateLoaded();
		this.activeOperationId = _operationId;
		const input = commandInput(command);
		const completions =
			command.command === "turn/start" || command.command === "turn/followUp"
				? await this.readPendingAgentCompletions()
				: [];
		const promptInput = appendAgentCompletions(input, completions);
		const harness = this.definition.harness;
		const operationModel = await harness.getModel();
		const extensionOperationModel = { id: operationModel.id, provider: operationModel.provider };
		const runCommand: CommandNameV2 = command.command;
		const payload = commandPayload(command);
		const queuedTurnOperation =
			(runCommand === "turn/followUp" || runCommand === "turn/steer") &&
			this.queuedTurnOperations.delete(_operationId);
		const usageBefore = (await harness.session.getStats()).totalTokens;
		const beforeEntryIds = new Set(
			(await harness.session.findEntriesOnBranch({ order: "oldestFirst" })).map((entry) => entry.id),
		);
		let goalUsageRecorded = false;
		let generateNameAfterTurn = false;
		const extensionHost = this.definition.extensionHost;
		if (!queuedTurnOperation) {
			this.phase = "turn";
			this.activeOperation = {
				operationId: _operationId,
				kind: runCommand,
				state: "running",
				acceptedSeq: this.activeOperation?.acceptedSeq ?? this.eventSeq,
				...(this.activeOperation?.compactionPolicy === undefined
					? {}
					: { compactionPolicy: this.activeOperation.compactionPolicy }),
			};
		}
		this.recordExtensionHookResults(
			_operationId,
			"accepted",
			await extensionHost?.onOperationAccepted({
				id: _operationId,
				type: runCommand,
				model: extensionOperationModel,
			}),
		);
		await this.recordInstructionProfile(_operationId);
		try {
			assertPromptCapabilities(await harness.getModel(), promptInput);
			if (runCommand === "turn/start") {
				const result = await harness.prompt(promptInput);
				if (!result.ok) throw new Error(result.error.message);
				if (result.value.kind === "failed") throw new Error(result.value.error.message);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordCurrentGoalUsage(usageBefore);
				await this.markAgentCompletionsConsumed(completions);
				goalUsageRecorded = true;
				generateNameAfterTurn = this.autoName;
			} else if (runCommand === "turn/resume") {
				const result = await harness.resume();
				if (!result.ok) throw new Error(result.error.message);
				if (result.value.kind === "failed") throw new Error(result.value.error.message);
				this.recoveryState = "recovered";
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordCurrentGoalUsage(usageBefore);
				goalUsageRecorded = true;
			} else if (runCommand === "turn/steer") {
				await harness.steer(input);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordCurrentGoalUsage(usageBefore);
				goalUsageRecorded = true;
			} else if (runCommand === "turn/followUp") {
				await harness.followUp(promptInput);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordCurrentGoalUsage(usageBefore);
				await this.markAgentCompletionsConsumed(completions);
				goalUsageRecorded = true;
			} else if (runCommand === "turn/abort") {
				await this.definition.abortChildren?.();
				await harness.abort();
			} else if (runCommand === "turn/rollback") {
				const turns = typeof payload.turns === "number" ? payload.turns : 1;
				const result = await harness.rollback(turns);
				if (!result.ok) throw new Error(result.error.message);
			} else if (runCommand === "turn/compact") {
				const result = await harness.compact({
					customInstructions:
						typeof payload.customInstructions === "string" ? payload.customInstructions : undefined,
				});
				if (!result.ok) throw new Error(result.error.message);
				if (result.value.kind === "failed") throw new Error(result.value.error.message);
				if (result.value.kind === "completed") await this.recordUsageLedger(_operationId, beforeEntryIds);
			} else if (runCommand === "session/steering-mode/set") {
				if (payload.mode !== "all" && payload.mode !== "one-at-a-time")
					throw new Error("session/steering-mode/set requires a valid mode");
				await harness.setSteeringMode(payload.mode);
			} else if (runCommand === "session/follow-up-mode/set") {
				if (payload.mode !== "all" && payload.mode !== "one-at-a-time")
					throw new Error("session/follow-up-mode/set requires a valid mode");
				await harness.setFollowUpMode(payload.mode);
			} else if (runCommand === "session/compaction/set") {
				if (typeof payload.enabled !== "boolean") throw new Error("session/compaction/set requires enabled");
				await harness.setCompactionEnabled(payload.enabled);
			} else if (runCommand === "session/retry/set") {
				if (typeof payload.enabled !== "boolean") throw new Error("session/retry/set requires enabled");
				const policy = await harness.getRetryPolicy();
				await harness.setRetryPolicy({ ...policy, enabled: payload.enabled });
			} else if (runCommand === "goal/create") {
				if (!this.definition.goals || typeof payload.objective !== "string")
					throw new Error("goal/create requires an objective");
				await this.definition.goals.create(
					payload.objective,
					typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined,
				);
			} else if (runCommand === "goal/update") {
				if (!this.definition.goals) throw new Error("Goals are not configured");
				const patch: Parameters<GoalManager["update"]>[0] = {};
				if (typeof payload.status === "string")
					patch.status = payload.status as Parameters<GoalManager["update"]>[0]["status"];
				if (typeof payload.tokensUsed === "number") patch.tokensUsed = payload.tokensUsed;
				if (typeof payload.activeTimeSeconds === "number") patch.activeTimeSeconds = payload.activeTimeSeconds;
				if (typeof payload.tokenBudget === "number") patch.tokenBudget = payload.tokenBudget;
				await this.definition.goals.update(patch);
			} else if (runCommand === "goal/pause") {
				if (!this.definition.goals) throw new Error("Goals are not configured");
				await this.definition.goals.pause();
			} else if (runCommand === "goal/resume") {
				if (!this.definition.goals) throw new Error("Goals are not configured");
				await this.definition.goals.resume();
			} else if (runCommand === "session/model/set") {
				if (typeof payload.provider !== "string" || typeof payload.id !== "string")
					throw new Error("session/model/set requires provider and id");
				const model = this.models.getModel(payload.provider, payload.id);
				if (!model) throw new Error(`Unknown model ${payload.provider}/${payload.id}`);
				await harness.setModel(model);
				this.model = model;
			} else if (runCommand === "session/thinking/set") {
				if (typeof payload.level !== "string") throw new Error("session/thinking/set requires level");
				await harness.setThinkingLevel(payload.level as ThinkingLevel);
			} else if (runCommand === "session/name/set") {
				if (payload.name !== null && typeof payload.name !== "string")
					throw new Error("session/name/set requires name or null");
				this.sessionName = payload.name === null ? undefined : payload.name;
				this.nameSource = payload.name === null ? undefined : "explicit";
				await harness.session.setName(this.sessionName);
				this.nameRevision += 1;
				await this.persistNameState();
			} else if (runCommand === "session/name/generate") {
				const requestedName = typeof payload.name === "string" ? payload.name : undefined;
				const generated = requestedName === undefined ? undefined : normalizeGeneratedName(requestedName);
				if (requestedName !== undefined && generated === undefined)
					throw new Error("session/name/generate requires a safe bounded name");
				if (generated === undefined) await this.generateName(_operationId);
				if (this.nameSource !== "explicit") {
					if (generated !== undefined) {
						this.sessionName = generated;
						this.nameSource = "generated";
						await harness.session.setName(generated);
						this.nameRevision += 1;
						await this.persistNameState();
					}
				}
			} else if (runCommand === "session/name/auto/set") {
				if (typeof payload.enabled !== "boolean") throw new Error("session/name/auto/set requires enabled");
				this.autoName = payload.enabled;
				await harness.session.appendCustomEntry("auto_name_setting", payload.enabled);
			}
		} catch (error) {
			this.activeOperationId = undefined;
			if (!goalUsageRecorded) {
				try {
					await this.recordCurrentGoalUsage(usageBefore);
				} catch {
					// Usage attribution must not hide the original operation failure.
				}
			}
			if (!queuedTurnOperation) {
				this.phase = "failed";
				this.activeOperation = {
					...this.activeOperation!,
					state: "failed",
					terminalSeq: this.eventSeq + 1,
				};
			}
			this.recordExtensionHookResults(
				_operationId,
				"terminal",
				await extensionHost?.onOperationTerminal(
					{ id: _operationId, type: runCommand, model: extensionOperationModel },
					"failed",
				),
			);
			throw error;
		}
		void this.autoName;
		this.recordExtensionHookResults(
			_operationId,
			"terminal",
			await extensionHost?.onOperationTerminal(
				{ id: _operationId, type: runCommand, model: extensionOperationModel },
				"completed",
			),
		);
		if (!queuedTurnOperation) {
			this.revision += 1;
			this.eventSeq += 1;
			this.phase = "idle";
			this.activeOperation = {
				...this.activeOperation!,
				state: "complete",
				terminalSeq: this.eventSeq,
			};
		}
		if (generateNameAfterTurn) this.scheduleNameGeneration(_operationId);
		if (runCommand === "turn/start" || runCommand === "turn/resume" || runCommand === "turn/followUp")
			void this.definition.goalContinuation?.schedule().catch(() => undefined);
		this.activeOperationId = undefined;
	}

	async cancelQueued(entryId: string): Promise<void> {
		const result = await this.definition.harness.cancelQueued(entryId);
		if (!result.ok) throw new Error(result.error.message);
	}

	async dispose(): Promise<void> {
		this.activeOperationId = undefined;
		for (const unsubscribe of this.unsubscribeHarnessEvents) unsubscribe();
		this.eventListeners.clear();
		this.definition.onDispose?.();
		this.definition.goalContinuation?.close();
		await this.definition.harness.close();
	}

	async recordGoalUsage(tokens: number): Promise<void> {
		if (this.definition.goals && (await this.definition.goals.read()))
			await this.definition.goals.recordUsage(tokens);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.definition.harness.session.appendCustomEntry(customType, data);
	}

	async readCustomEntries(customType: string): Promise<readonly Entry[]> {
		return this.definition.harness.session.findEntries({ customType });
	}
}

export function createCodingAgentV2Service(
	models: Models,
	definitions: readonly CodingAgentV2SessionDefinition[],
	options?: CodingAgentV2ServiceOptions,
): CodingAgentV2Service {
	const byId = new Map(definitions.map((definition) => [definition.metadata.id, definition]));
	const knownIds = new Set(
		[...(options?.initialSessions ?? []), ...definitions.map((definition) => definition.metadata)].map(
			(item) => item.id,
		),
	);
	const runtimes = new Map<string, CodingAgentV2RuntimeImpl>();
	const sessionFactory = options?.createSession;
	const sessionForker = options?.forkSession;
	const sessionDeleter = options?.deleteSession;
	return {
		listSessions: async () =>
			options?.listSessions
				? structuredClone(await options.listSessions())
				: [...byId.values()].map((definition) => structuredClone(definition.metadata)),
		listModels: async () => models.getModels().map((model) => modelMetadata(model)),
		createSession: sessionFactory
			? async (payload) => {
					const definition = await sessionFactory(payload);
					if (byId.has(definition.metadata.id))
						throw new Error(`Session ${definition.metadata.id} already exists`);
					byId.set(definition.metadata.id, definition);
					knownIds.add(definition.metadata.id);
					const model = await definition.harness.getModel();
					const runtime = new CodingAgentV2RuntimeImpl(definition, models, model, options);
					runtimes.set(definition.metadata.id, runtime);
					return { sessionId: definition.metadata.id, runtime };
				}
			: undefined,
		forkSession: sessionForker
			? async (sourceSessionId, payload) => {
					const definition = await sessionForker(sourceSessionId, payload);
					if (byId.has(definition.metadata.id))
						throw new Error(`Session ${definition.metadata.id} already exists`);
					byId.set(definition.metadata.id, definition);
					knownIds.add(definition.metadata.id);
					const model = await definition.harness.getModel();
					const runtime = new CodingAgentV2RuntimeImpl(definition, models, model, options);
					runtimes.set(definition.metadata.id, runtime);
					return { sessionId: definition.metadata.id, runtime };
				}
			: undefined,
		deleteSession: sessionDeleter
			? async (sessionId) => {
					const runtime = runtimes.get(sessionId);
					if (runtime) {
						await runtime.dispose();
						runtimes.delete(sessionId);
					}
					if (!byId.delete(sessionId) && !knownIds.delete(sessionId))
						throw new Error(`Unknown session ${sessionId}`);
					knownIds.delete(sessionId);
					await sessionDeleter(sessionId);
				}
			: undefined,
		openSession: async (sessionId) => {
			let definition = byId.get(sessionId);
			if (!definition && options?.openSession) {
				definition = await options.openSession(sessionId);
				if (definition.metadata.id !== sessionId) throw new Error(`Opened session id mismatch: ${sessionId}`);
				byId.set(sessionId, definition);
				knownIds.add(sessionId);
			}
			if (!definition) throw new Error(`Unknown session ${sessionId}`);
			const existing = runtimes.get(sessionId);
			if (existing) return existing;
			const model = await definition.harness.getModel();
			const runtime = new CodingAgentV2RuntimeImpl(definition, models, model, options);
			runtimes.set(sessionId, runtime);
			return runtime;
		},
	};
}

export async function createCodingAgentV2ServiceFromStore(
	models: Models,
	store: CodingAgentV2SessionStore,
	options?: Pick<CodingAgentV2ServiceOptions, "fastModel" | "fastModelResolver">,
): Promise<CodingAgentV2Service> {
	const initialSessions = await store.list();
	return createCodingAgentV2Service(models, [], {
		...options,
		initialSessions,
		listSessions: () => store.list(),
		openSession: (sessionId) => store.open(sessionId),
		createSession: (payload) => store.create(payload),
		...(store.fork === undefined
			? {}
			: {
					forkSession: (sourceSessionId: string, payload: Record<string, unknown>) =>
						store.fork!(sourceSessionId, payload),
				}),
		deleteSession: (sessionId) => store.delete(sessionId),
	});
}
