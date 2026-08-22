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

async function modelMetadata(models: Models, model: Model<string>): Promise<ModelMetadata> {
	let authenticated = false;
	try {
		authenticated = (await models.getAuth(model)) !== undefined;
	} catch {
		authenticated = false;
	}
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
		authenticated,
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

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return String(message ?? "");
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("");
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
	private disposed = false;
	private readonly onDispose?: () => void;

	constructor(definition: CodingAgentV2SessionDefinition, models: Models, model: Model<string>, onDispose?: () => void) {
		this.definition = definition;
		this.models = models;
		this.model = model;
		this.sessionName = definition.metadata.sessionName;
		this.nameSource = definition.metadata.nameSource;
		this.onDispose = onDispose;
	}

	async snapshot(): Promise<SessionSnapshotV2> {
		if (this.disposed) throw new Error("Session runtime is disposed");
		const [watch, thinkingLevel, persistedName] = await Promise.all([
			this.definition.harness.watch(),
			this.definition.harness.getThinkingLevel(),
			this.definition.harness.session.getName(),
		]);
		const lane = watch.snapshot;
		const goal = await this.definition.goals?.read();
		const transcript = lane.transcript
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
			.map((message, index) => ({ id: `${this.definition.metadata.id}-${index + 1}`, ...message })) as SessionSnapshotV2["transcript"];
		const sessionName = persistedName ?? this.sessionName;
		return {
			id: this.definition.metadata.id,
			...(sessionName === undefined
				? {}
				: { name: sessionName, ...(this.nameSource === undefined ? {} : { nameSource: this.nameSource }) }),
			nameRevision: this.nameRevision,
			revision: this.revision,
			eventSeq: this.eventSeq,
			phase: "idle",
			model: { provider: this.model.provider, id: this.model.id },
			thinkingLevel,
			transcript,
			queues: {
				steer: lane.queues.steer.map((item) => ({ id: item.entryId, content: [{ type: "text", text: messageText(item.message) }], createdAt: 0 })),
				followUp: lane.queues.followUp.map((item) => ({ id: item.entryId, content: [{ type: "text", text: messageText(item.message) }], createdAt: 0 })),
			},
			...(goal === undefined ? {} : { goal }),
			agents: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingState: "unknown" },
			context: { inputTokens: 0, contextWindow: this.model.contextWindow, usedPercentage: 0 },
			compactionPolicy: {
				enabled: true,
				contextWindow: this.model.contextWindow,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
				triggerTokens: Math.max(0, this.model.contextWindow - 16_384),
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
		if (this.disposed) throw new Error("Session runtime is disposed");
		const text = commandText(command);
		const harness = this.definition.harness;
		const runCommand: CommandNameV2 = command.command;
		const payload = commandPayload(command);
		const unwrap = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
			if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
			return result.value as T;
		};
		if (runCommand === "turn/start") {
			const outcome = unwrap(await harness.prompt(text));
			if ("kind" in outcome && outcome.kind === "failed") throw new Error(outcome.error.message);
		} else if (runCommand === "turn/resume") {
			const outcome = unwrap(await harness.resume());
			if ("kind" in outcome && outcome.kind === "failed") throw new Error(outcome.error.message);
		} else if (runCommand === "turn/steer") unwrap(await harness.steer(text));
		else if (runCommand === "turn/followUp") unwrap(await harness.followUp(text));
		else if (runCommand === "turn/abort") unwrap(await harness.abort());
		else if (runCommand === "turn/rollback")
			throw new Error("Conversation rollback is not available in this adapter");
		else if (runCommand === "goal/create") {
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
		} else if (runCommand === "goal/pause") {
			if (!this.definition.goals) throw new Error("Goals are not configured");
			await this.definition.goals.pause();
		} else if (runCommand === "goal/resume") {
			if (!this.definition.goals) throw new Error("Goals are not configured");
			await this.definition.goals.resume();
		}
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
			await harness.session.setName(this.sessionName);
		} else if (runCommand === "session/name/generate") {
			const generated =
				typeof payload.name === "string" && payload.name.trim().length > 0
					? payload.name.trim()
					: "Untitled session";
			if (this.nameSource !== "explicit") {
				this.sessionName = generated;
				this.nameSource = "generated";
				this.nameRevision += 1;
				await harness.session.setName(this.sessionName);
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
		if (this.disposed) return;
		this.disposed = true;
		this.onDispose?.();
		await this.definition.harness.close();
	}
}

export function createCodingAgentV2Service(
	models: Models,
	definitions: readonly CodingAgentV2SessionDefinition[],
): CodingAgentV2Service {
	const byId = new Map(definitions.map((definition) => [definition.metadata.id, definition]));
	const runtimes = new Map<string, CodingAgentV2RuntimeImpl>();
	const opening = new Map<string, Promise<CodingAgentV2RuntimeImpl>>();
	return {
		listSessions: async () => definitions.map((definition) => structuredClone(definition.metadata)),
		listModels: async () => Promise.all(models.getModels().map((model) => modelMetadata(models, model))),
		openSession: async (sessionId) => {
			const definition = byId.get(sessionId);
			if (!definition) throw new Error(`Unknown session ${sessionId}`);
			const existing = runtimes.get(sessionId);
			if (existing) return existing;
			const pending = opening.get(sessionId);
			if (pending) return pending;
			const promise = (async () => {
				const model = await definition.harness.getModel();
				const runtime = new CodingAgentV2RuntimeImpl(definition, models, model, () => runtimes.delete(sessionId));
				runtimes.set(sessionId, runtime);
				return runtime;
			})();
			opening.set(sessionId, promise);
			try {
				return await promise;
			} finally {
				opening.delete(sessionId);
			}
		},
	};
}
