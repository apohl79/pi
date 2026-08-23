import type {
	AgentHarness,
	AgentMessage,
	Entry,
	GoalContinuationScheduler,
	GoalManager,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Message, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	AgentSummary,
	CommandNameV2,
	CommandV2,
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
import type { V2InputRegistry, V2UsageLedger } from "@earendil-works/pi-server";
import type { ServerRuntimeExtensionHost } from "./extension-host.ts";

export interface CodingAgentV2SessionDefinition {
	metadata: SessionMetadataV2;
	harness: AgentHarness;
	goals?: GoalManager;
	goalContinuation?: GoalContinuationScheduler;
	extensionHost?: ServerRuntimeExtensionHost;
	inputs?: V2InputRegistry;
	usage?: V2UsageLedger;
	instructionProfile?: () => Promise<InstructionProfileSummary | undefined>;
	pluginSetHash?: () => Promise<string>;
	agents?: () => Promise<readonly AgentSummary[]>;
	plan?: () => Promise<PlanSnapshot | undefined>;
	diagnostics?: () => Promise<DiagnosticsSnapshot>;
	queues?: () => Promise<{
		steer: readonly { entryId: string; message: AgentMessage }[];
		followUp: readonly { entryId: string; message: AgentMessage }[];
	}>;
}

export interface CodingAgentV2Service {
	listSessions(): Promise<SessionMetadataV2[]>;
	listModels(): Promise<ModelMetadata[]>;
	openSession(sessionId: string): Promise<CodingAgentV2Runtime>;
	createSession?(options: Record<string, unknown>): Promise<{ sessionId: string; runtime: CodingAgentV2Runtime }>;
	deleteSession?(sessionId: string): Promise<void>;
}

export interface CodingAgentV2ServiceOptions {
	/** Provider-local fast model used only for side-band automatic naming. */
	fastModel?: Model<string>;
	/** Durable owner creates a fully initialized session definition. */
	createSession?: (options: Record<string, unknown>) => Promise<CodingAgentV2SessionDefinition>;
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
	delete(sessionId: string): Promise<void>;
}

export interface CodingAgentV2Runtime {
	snapshot(): Promise<SessionSnapshotV2>;
	accept(operationId: string): Promise<OperationAccepted>;
	run(operationId: string, command: CommandV2): Promise<void>;
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

function queueContent(message: AgentMessage): PromptContent[] {
	if (message.role !== "user") return [{ type: "text", text: `[${message.role} message]` }];
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((part) =>
		part.type === "text" ? { type: "text", text: part.text } : { type: "text", text: "[image]" },
	);
}

export function normalizeGeneratedName(value: string): string | undefined {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/^(?:title|session\s+name)\s*[:-]\s*/i, "")
		.replace(/^here(?:'s| is)\s+(?:a|the)?\s*(?:title|session\s+name)\s*[:-]?\s*/i, "")
		.replace(/\s+/g, " ")
		.replace(/^['"`]+|['"`]+$/g, "")
		.trim();
	if (/^(?:answer|sure|okay|ok|here you go)\b[.!]?$/i.test(cleaned)) return undefined;
	if (/(?:sk|pk|api[_-]?key|bearer)\s*[:=]\s*\S+/i.test(cleaned)) return undefined;
	const words = cleaned.split(" ").filter(Boolean).slice(0, 7);
	if (words.length < 2) return undefined;
	const joined = words.join(" ");
	let name = joined.slice(0, 32);
	if (joined.length > 32) name = name.replace(/\s+\S*$/, "").trimEnd();
	if (name.split(" ").length < 2) return undefined;
	return name;
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
	private sessionName: string | undefined;
	private nameSource: "explicit" | "generated" | "derived" | undefined;
	private phase: SessionPhaseV2 = "idle";
	private activeOperation: OperationSummary | undefined;

	private readonly fastModel: Model<string> | undefined;

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
		this.fastModel = options?.fastModel;
	}

	private async generateName(operationId: string): Promise<void> {
		if (!this.fastModel) return;
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
		const response = await this.models.completeSimple(this.fastModel, {
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
	}

	private async recordGoalUsage(beforeTokens: number): Promise<void> {
		if (!this.definition.goals) return;
		if (!(await this.definition.goals.read())) return;
		const afterTokens = (await this.definition.harness.session.getStats()).totalTokens;
		const delta = Math.max(0, afterTokens - beforeTokens);
		if (delta > 0) await this.definition.goals.recordUsage(delta);
	}

	private async recordUsageLedger(operationId: string, beforeEntryIds: ReadonlySet<string>): Promise<void> {
		const ledger = this.definition.usage;
		if (!ledger) return;
		const goalId = (await this.definition.goals?.read())?.id;
		const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		for (const entry of entries) {
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
		const [
			leafId,
			thinkingLevel,
			steeringMode,
			followUpMode,
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
		const cacheRead = Math.max(0, stats.cachedTokens);
		const input = Math.max(0, stats.uncachedTokens);
		const output = Math.max(0, stats.totalTokens - stats.cachedTokens - stats.uncachedTokens);
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
					content: queueContent(item.message),
					createdAt: item.message.timestamp ?? 0,
				})),
				followUp: (queues?.followUp ?? []).map((item) => ({
					id: item.entryId,
					content: queueContent(item.message),
					createdAt: item.message.timestamp ?? 0,
				})),
			},
			steeringMode,
			followUpMode,
			...(goal === undefined ? {} : { goal }),
			...(plan === undefined ? {} : { plan }),
			agents: agents === undefined ? [] : [...agents],
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
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
			persistence: { schemaVersion: 1, recoveryState: "clean" },
			createdAt: this.definition.metadata.createdAt,
			updatedAt: this.definition.metadata.updatedAt ?? this.definition.metadata.createdAt,
		};
	}

	async accept(_operationId: string): Promise<OperationAccepted> {
		this.revision += 1;
		this.eventSeq += 1;
		this.phase = "turn";
		this.activeOperation = {
			operationId: _operationId,
			kind: "pending",
			state: "accepted",
			acceptedSeq: this.eventSeq,
		};
		return { operationId: _operationId, sessionRevision: this.revision, eventSeq: this.eventSeq };
	}

	async run(_operationId: string, command: CommandV2): Promise<void> {
		const input = commandInput(command);
		const harness = this.definition.harness;
		const runCommand: CommandNameV2 = command.command;
		const payload = commandPayload(command);
		const usageBefore = (await harness.session.getStats()).totalTokens;
		const beforeEntryIds = new Set(
			(await harness.session.findEntriesOnBranch({ order: "oldestFirst" })).map((entry) => entry.id),
		);
		let goalUsageRecorded = false;
		const extensionHost = this.definition.extensionHost;
		this.phase = "turn";
		this.activeOperation = {
			operationId: _operationId,
			kind: runCommand,
			state: "running",
			acceptedSeq: this.activeOperation?.acceptedSeq ?? this.eventSeq,
		};
		await extensionHost?.onOperationAccepted({ id: _operationId, type: runCommand });
		try {
			assertPromptCapabilities(await harness.getModel(), input);
			if (runCommand === "turn/start") {
				await harness.prompt(input);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordGoalUsage(usageBefore);
				goalUsageRecorded = true;
				if (this.autoName) await this.generateName(_operationId);
			} else if (runCommand === "turn/resume") {
				const result = await harness.resume();
				if (!result.ok) throw new Error(result.error.message);
				if (result.value.kind === "failed") throw new Error(result.value.error.message);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordGoalUsage(usageBefore);
				goalUsageRecorded = true;
			} else if (runCommand === "turn/steer") {
				await harness.steer(input);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordGoalUsage(usageBefore);
				goalUsageRecorded = true;
			} else if (runCommand === "turn/followUp") {
				await harness.followUp(input);
				await this.recordUsageLedger(_operationId, beforeEntryIds);
				await this.recordGoalUsage(usageBefore);
				goalUsageRecorded = true;
			} else if (runCommand === "turn/abort") await harness.abort();
			else if (runCommand === "turn/rollback") {
				const turns = typeof payload.turns === "number" ? payload.turns : 1;
				const result = await harness.rollback(turns);
				if (!result.ok) throw new Error(result.error.message);
			} else if (runCommand === "turn/compact") {
				const result = await harness.compact({
					customInstructions:
						typeof payload.customInstructions === "string" ? payload.customInstructions : undefined,
				});
				if (!result.ok) throw new Error(result.error.message);
			} else if (runCommand === "session/steering-mode/set") {
				if (payload.mode !== "all" && payload.mode !== "one-at-a-time")
					throw new Error("session/steering-mode/set requires a valid mode");
				await harness.setSteeringMode(payload.mode);
			} else if (runCommand === "session/follow-up-mode/set") {
				if (payload.mode !== "all" && payload.mode !== "one-at-a-time")
					throw new Error("session/follow-up-mode/set requires a valid mode");
				await harness.setFollowUpMode(payload.mode);
			} else if (runCommand === "goal/create") {
				if (!this.definition.goals || typeof payload.objective !== "string")
					throw new Error("goal/create requires an objective");
				await this.definition.goals.create(
					payload.objective,
					typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined,
				);
			} else if (runCommand === "goal/update") {
				if (!this.definition.goals) throw new Error("Goals are not configured");
				await this.definition.goals.update({
					status:
						typeof payload.status === "string"
							? (payload.status as Parameters<GoalManager["update"]>[0]["status"])
							: undefined,
					tokensUsed: typeof payload.tokensUsed === "number" ? payload.tokensUsed : undefined,
					activeTimeSeconds: typeof payload.activeTimeSeconds === "number" ? payload.activeTimeSeconds : undefined,
					tokenBudget: typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined,
				});
			} else if (runCommand === "goal/pause") await this.definition.goals?.pause();
			else if (runCommand === "goal/resume") await this.definition.goals?.resume();
			else if (runCommand === "session/model/set") {
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
			} else if (runCommand === "session/name/generate") {
				const generated =
					typeof payload.name === "string" && payload.name.trim().length > 0 ? payload.name.trim() : undefined;
				if (generated === undefined) await this.generateName(_operationId);
				if (this.nameSource !== "explicit") {
					if (generated !== undefined) {
						this.sessionName = generated;
						this.nameSource = "generated";
						await harness.session.setName(generated);
						this.nameRevision += 1;
					}
				}
			} else if (runCommand === "session/name/auto/set") {
				if (typeof payload.enabled !== "boolean") throw new Error("session/name/auto/set requires enabled");
				this.autoName = payload.enabled;
			}
		} catch (error) {
			if (!goalUsageRecorded) {
				try {
					await this.recordGoalUsage(usageBefore);
				} catch {
					// Usage attribution must not hide the original operation failure.
				}
			}
			this.phase = "failed";
			this.activeOperation = {
				...this.activeOperation!,
				state: "failed",
				terminalSeq: this.eventSeq + 1,
			};
			await extensionHost?.onOperationTerminal({ id: _operationId, type: runCommand }, "failed");
			throw error;
		}
		void this.autoName;
		await extensionHost?.onOperationTerminal({ id: _operationId, type: runCommand }, "completed");
		this.revision += 1;
		this.eventSeq += 1;
		this.phase = "idle";
		this.activeOperation = {
			...this.activeOperation!,
			state: "complete",
			terminalSeq: this.eventSeq,
		};
		if (runCommand === "turn/start" || runCommand === "turn/resume" || runCommand === "turn/followUp")
			void this.definition.goalContinuation?.schedule().catch(() => undefined);
	}

	async dispose(): Promise<void> {
		this.definition.goalContinuation?.close();
		await this.definition.harness.close();
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
	options?: Pick<CodingAgentV2ServiceOptions, "fastModel">,
): Promise<CodingAgentV2Service> {
	const initialSessions = await store.list();
	return createCodingAgentV2Service(models, [], {
		...options,
		initialSessions,
		listSessions: () => store.list(),
		openSession: (sessionId) => store.open(sessionId),
		createSession: (payload) => store.create(payload),
		deleteSession: (sessionId) => store.delete(sessionId),
	});
}
