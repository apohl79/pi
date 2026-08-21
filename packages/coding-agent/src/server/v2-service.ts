import type { AgentHarness, GoalManager } from "@earendil-works/pi-agent-core";
import type { Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	CommandNameV2,
	CommandV2,
	ModelMetadata,
	OperationAccepted,
	SessionMetadataV2,
	SessionSnapshotV2,
} from "@earendil-works/pi-protocol";

export interface CodingAgentV2SessionDefinition {
	metadata: SessionMetadataV2;
	harness: AgentHarness;
	goals?: GoalManager;
}

export interface CodingAgentV2Service {
	listSessions(): Promise<SessionMetadataV2[]>;
	listModels(): Promise<ModelMetadata[]>;
	openSession(sessionId: string): Promise<CodingAgentV2Runtime>;
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

function commandText(command: CommandV2): string {
	const payload = command.payload;
	if (
		typeof payload === "object" &&
		payload !== null &&
		!Array.isArray(payload) &&
		typeof (payload as { text?: unknown }).text === "string"
	)
		return (payload as { text: string }).text;
	return "";
}

function commandPayload(command: CommandV2): Record<string, unknown> {
	return typeof command.payload === "object" && command.payload !== null && !Array.isArray(command.payload)
		? (command.payload as Record<string, unknown>)
		: {};
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

	constructor(definition: CodingAgentV2SessionDefinition, models: Models, model: Model<string>) {
		this.definition = definition;
		this.models = models;
		this.model = model;
		this.sessionName = definition.metadata.sessionName;
		this.nameSource = definition.metadata.nameSource;
	}

	async snapshot(): Promise<SessionSnapshotV2> {
		const [leafId, thinkingLevel, stats, compaction] = await Promise.all([
			this.definition.harness.getLeafId(),
			this.definition.harness.getThinkingLevel(),
			this.definition.harness.session.getStats(),
			this.definition.harness.getCompactionSettings(),
		]);
		void leafId;
		const goal = await this.definition.goals?.read();
		const cacheRead = Math.max(0, stats.cachedTokens);
		const input = Math.max(0, stats.uncachedTokens);
		const output = Math.max(0, stats.totalTokens - stats.cachedTokens - stats.uncachedTokens);
		const contextWindow = Math.max(1, this.model.contextWindow);
		const reserveTokens = Math.max(0, compaction.reserveTokens);
		return {
			id: this.definition.metadata.id,
			...(this.sessionName === undefined
				? {}
				: { name: this.sessionName, ...(this.nameSource === undefined ? {} : { nameSource: this.nameSource }) }),
			nameRevision: this.nameRevision,
			revision: this.revision,
			eventSeq: this.eventSeq,
			phase: "idle",
			model: { provider: this.model.provider, id: this.model.id },
			thinkingLevel,
			transcript: [],
			queues: { steer: [], followUp: [] },
			...(goal === undefined ? {} : { goal }),
			agents: [],
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				...(stats.costTotal > 0 ? { costUsd: stats.costTotal } : {}),
				pricingState: "known",
			},
			context: {
				inputTokens: Math.max(0, stats.totalTokens),
				contextWindow,
				usedPercentage: Math.min(100, (Math.max(0, stats.totalTokens) / contextWindow) * 100),
			},
			compactionPolicy: {
				enabled: compaction.enabled,
				contextWindow,
				reserveTokens,
				keepRecentTokens: Math.max(0, compaction.keepRecentTokens),
				triggerTokens: Math.max(0, contextWindow - reserveTokens),
				source: "global",
			},
			pluginSetHash: "plugins-empty",
			diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 0 },
			persistence: { schemaVersion: 1, recoveryState: "clean" },
			createdAt: this.definition.metadata.createdAt,
			updatedAt: this.definition.metadata.updatedAt ?? this.definition.metadata.createdAt,
		};
	}

	async accept(_operationId: string): Promise<OperationAccepted> {
		this.revision += 1;
		this.eventSeq += 1;
		return { operationId: _operationId, sessionRevision: this.revision, eventSeq: this.eventSeq };
	}

	async run(_operationId: string, command: CommandV2): Promise<void> {
		const text = commandText(command);
		const harness = this.definition.harness;
		const runCommand: CommandNameV2 = command.command;
		const payload = commandPayload(command);
		if (runCommand === "turn/start" || runCommand === "turn/resume") await harness.prompt(text);
		else if (runCommand === "turn/steer") await harness.steer(text);
		else if (runCommand === "turn/followUp") await harness.followUp(text);
		else if (runCommand === "turn/abort") await harness.abort();
		else if (runCommand === "turn/rollback") {
			const turns = typeof payload.turns === "number" ? payload.turns : 1;
			const result = await harness.rollback(turns);
			if (!result.ok) throw new Error(result.error.message);
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
			this.nameRevision += 1;
		} else if (runCommand === "session/name/generate") {
			const generated =
				typeof payload.name === "string" && payload.name.trim().length > 0
					? payload.name.trim()
					: "Untitled session";
			if (this.nameSource !== "explicit") {
				this.sessionName = generated;
				this.nameSource = "generated";
				this.nameRevision += 1;
			}
		} else if (runCommand === "session/name/auto/set") {
			if (typeof payload.enabled !== "boolean") throw new Error("session/name/auto/set requires enabled");
			this.autoName = payload.enabled;
		}
		void this.autoName;
		this.revision += 1;
		this.eventSeq += 1;
	}

	async dispose(): Promise<void> {
		await this.definition.harness.close();
	}
}

export function createCodingAgentV2Service(
	models: Models,
	definitions: readonly CodingAgentV2SessionDefinition[],
): CodingAgentV2Service {
	const byId = new Map(definitions.map((definition) => [definition.metadata.id, definition]));
	const runtimes = new Map<string, CodingAgentV2RuntimeImpl>();
	return {
		listSessions: async () => definitions.map((definition) => structuredClone(definition.metadata)),
		listModels: async () => models.getModels().map((model) => modelMetadata(model)),
		openSession: async (sessionId) => {
			const definition = byId.get(sessionId);
			if (!definition) throw new Error(`Unknown session ${sessionId}`);
			const existing = runtimes.get(sessionId);
			if (existing) return existing;
			const model = await definition.harness.getModel();
			const runtime = new CodingAgentV2RuntimeImpl(definition, models, model);
			runtimes.set(sessionId, runtime);
			return runtime;
		},
	};
}
