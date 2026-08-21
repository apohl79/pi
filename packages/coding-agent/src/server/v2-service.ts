import type { AgentHarness, Entry, GoalManager } from "@earendil-works/pi-agent-core";
import type { Message, Model, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	CommandNameV2,
	CommandV2,
	JsonValue,
	ModelMetadata,
	OperationAccepted,
	SessionMetadataV2,
	SessionSnapshotV2,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import type { ServerRuntimeExtensionHost } from "./extension-host.ts";

export interface CodingAgentV2SessionDefinition {
	metadata: SessionMetadataV2;
	harness: AgentHarness;
	goals?: GoalManager;
	extensionHost?: ServerRuntimeExtensionHost;
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

export interface CodingAgentV2ServiceOptions {
	/** Provider-local fast model used only for side-band automatic naming. */
	fastModel?: Model<string>;
}

export interface CodingAgentV2Runtime {
	snapshot(): Promise<SessionSnapshotV2>;
	accept(operationId: string): Promise<OperationAccepted>;
	run(operationId: string, command: CommandV2): Promise<void>;
	abort(operationId: string): Promise<void>;
	dispose(): Promise<void>;
}

async function modelMetadata(models: Models, model: Model<string>): Promise<ModelMetadata> {
	const provider = boundedRequired(model.provider, 256);
	const id = boundedRequired(model.id, 256);
	const name = boundedRequired(model.name, MAX_V2_STRING_LENGTH);
	const api = boundedRequired(model.api, 256);
	if (!provider || !id || !name || !api) throw new Error("Model metadata contains an invalid required field");
	let authenticated = false;
	try {
		authenticated = (await models.getAuth(model)) !== undefined;
	} catch {
		authenticated = false;
	}
	return {
		provider,
		id,
		name,
		api,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: {
			input: finiteNonNegative(model.cost.input),
			output: finiteNonNegative(model.cost.output),
			cacheRead: finiteNonNegative(model.cost.cacheRead),
			cacheWrite: finiteNonNegative(model.cost.cacheWrite),
		},
		supportedThinkingLevels: model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : ["off"],
		authenticated,
	};
}

function requirePayload(command: CommandV2): Record<string, unknown> {
	const payload = command.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error(`${command.command} requires an object payload`);
	}
	return payload as Record<string, unknown>;
}

function requireText(command: CommandV2, payload: Record<string, unknown>): string {
	if (typeof payload.text !== "string" || payload.text.trim().length === 0 || payload.text.length > MAX_V2_STRING_LENGTH)
		throw new Error(`${command.command} requires bounded non-empty text`);
	return payload.text;
}

function commandInput(command: CommandV2): AgentMessage {
	const payload = requirePayload(command);
	if (payload.content === undefined) return { role: "user", content: [{ type: "text", text: requireText(command, payload) }], timestamp: Date.now() };
	if (!Array.isArray(payload.content) || payload.content.length === 0) throw new Error("turn content must be a non-empty array");
	const content = payload.content.map((part, index) => {
		if (typeof part !== "object" || part === null || Array.isArray(part)) throw new Error(`turn content item ${index} must be an object`);
		const item = part as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
		if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string" && item.mimeType.startsWith("image/")) return { type: "image", data: item.data, mimeType: item.mimeType };
		throw new Error(`turn content item ${index} must be text or resolved image data`);
	});
	return { role: "user", content, timestamp: Date.now() };
}

function requireBoundedNonEmptyString(command: CommandV2, value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_V2_STRING_LENGTH)
		throw new Error(`${command.command} requires bounded non-empty ${field}`);
	return value;
}

function sessionNameValue(command: CommandV2, value: unknown): string {
	const sanitized = redactText(requireBoundedNonEmptyString(command, value, "name")).slice(0, 256).trim();
	if (sanitized.length === 0) throw new Error(`${command.command} requires a non-empty name after sanitization`);
	return sanitized;
}

export function normalizeGeneratedName(value: string): string | undefined {
	const cleaned = value.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").replace(/^(?:title|session\s+name)\s*[:-]\s*/i, "").replace(/\s+/g, " ").replace(/^[\'\"`]+|[\'\"`]+$/g, "").trim();
	if (/^(?:answer|sure|okay|ok|here you go)\b[.!]?$/i.test(cleaned)) return undefined;
	if (/(?:sk|pk|api[_-]?key|bearer|token|password|secret|authorization)\s*[:=]\s*\S+/i.test(cleaned)) return undefined;
	const words = cleaned.split(" ").filter(Boolean).slice(0, 7);
	if (words.length < 2) return undefined;
	const joined = words.join(" ");
	let name = joined.slice(0, 32);
	if (joined.length > 32) name = name.replace(/\s+\S*$/, "").trimEnd();
	return name.split(" ").length < 2 ? undefined : name;
}

function commandPayload(command: CommandV2): Record<string, unknown> {
	return typeof command.payload === "object" && command.payload !== null && !Array.isArray(command.payload)
		? (command.payload as Record<string, unknown>)
		: {};
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
	private revision = 0;
	private eventSeq = 0;
	private readonly definition: CodingAgentV2SessionDefinition;
	private readonly models: Models;
	private model: Model<string>;
	private nameRevision = 0;
	private autoName = true;
	private sessionName: string | undefined;
	private nameSource: "explicit" | "generated" | "derived" | undefined;
	private disposed = false;
	private readonly operations = new Map<string, PersistedOperation>();
	private operationId?: string;
	private freshOperationId?: string;
	private mutationTail: Promise<void> = Promise.resolve();
	private executionTail: Promise<void> = Promise.resolve();
	private readonly onDispose?: () => void;

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

	private async generateName(): Promise<void> {
		if (!this.fastModel) return;
		const initialSource = this.nameSource;
		if (initialSource === "explicit") return;
		const initialRevision = this.nameRevision;
		const initialName = await this.definition.harness.session.getName();
		if (initialName !== undefined) return;
		const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const transcript = entries
			.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
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
			.slice(-4000);
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
		const generated = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join(" ")
			.replace(/[\r\n]+/g, " ")
			.replace(/^["'`]+|["'`]+$/g, "")
			.trim()
			.slice(0, 120);
		if (generated.length === 0 || this.nameRevision !== initialRevision || this.nameSource !== initialSource) return;
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
		this.sessionName = generated;
		this.nameSource = "generated";
		this.nameRevision += 1;
	}

	async snapshot(): Promise<SessionSnapshotV2> {
		const [leafId, thinkingLevel, stats, compaction, entries] = await Promise.all([
			this.definition.harness.getLeafId(),
			this.definition.harness.getThinkingLevel(),
			this.definition.harness.session.getStats(),
			this.definition.harness.getCompactionSettings(),
			this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }),
		]);
		void leafId;
		const [goal, persistedName] = await Promise.all([
			this.definition.goals?.read(),
			this.definition.harness.session.getName(),
		]);
		const effectiveName = persistedName ?? this.sessionName;
		const cacheRead = Math.max(0, stats.cachedTokens);
		const input = Math.max(0, stats.uncachedTokens);
		const output = Math.max(0, stats.totalTokens - stats.cachedTokens - stats.uncachedTokens);
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
			phase,
			...(active === undefined ? {} : { activeOperation: active }),
			model: { provider: boundedString(this.model.provider), id: boundedString(this.model.id) },
			thinkingLevel,
			transcript,
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
			persistence: { schemaVersion: 1, recoveryState: active?.state === "suspended" ? "recovered" : "clean" },
			createdAt: this.definition.metadata.createdAt,
			updatedAt: this.definition.metadata.updatedAt ?? this.definition.metadata.createdAt,
		};
	}

	private restoreOperationState(entries: readonly Entry[]): void {
		for (const entry of entries) {
			this.revision = Math.max(this.revision, finiteTimestamp(entry.seq));
			if (entry.type !== "custom" || entry.customType !== OPERATION_ENTRY || typeof entry.data !== "object" || entry.data === null) continue;
			const data = entry.data as Partial<PersistedOperation>;
			const states = ["accepted", "running", "complete", "failed", "aborted", "suspended"];
			if (
				typeof data.operationId !== "string" || data.operationId.length === 0 || data.operationId.length > 256 ||
				!states.includes(data.state as string) || typeof data.kind !== "string" || data.kind.length === 0 || data.kind.length > 256 ||
				![data.revision, data.eventSeq, data.acceptedSeq].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
			) continue;
			this.operations.set(data.operationId, data as PersistedOperation);
			this.revision = Math.max(this.revision, data.revision);
			this.eventSeq = Math.max(this.eventSeq, data.eventSeq);
		}
	}

	private async persistOperation(operation: PersistedOperation): Promise<void> {
		try {
			await this.definition.harness.session.appendCustomEntry(OPERATION_ENTRY, operation);
		} catch (error) {
			const entries = await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }).catch(() => []);
			const committed = entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === OPERATION_ENTRY &&
					JSON.stringify(entry.data) === JSON.stringify(operation),
			);
			if (!committed) throw error;
		}
		this.operations.set(operation.operationId, operation);
		this.revision = Math.max(this.revision, operation.revision);
		this.eventSeq = Math.max(this.eventSeq, operation.eventSeq);
	}

	private activeOperation(laneOperation: { id: string; intent: { kind: string } } | undefined): SessionSnapshotV2["activeOperation"] {
		const persisted = this.operationId ? this.operations.get(this.operationId) : [...this.operations.values()].find((operation) => operation.state === "accepted" || operation.state === "running" || operation.state === "suspended");
		if (!persisted) return undefined;
		const state = laneOperation || this.operationId === persisted.operationId
			? "running"
			: this.freshOperationId === persisted.operationId && persisted.state === "accepted"
				? "accepted"
			: persisted.state === "accepted" || persisted.state === "running"
				? "suspended"
				: persisted.state;
		return { operationId: persisted.operationId, kind: persisted.kind, state: state === "suspended" ? "suspended" : state === "accepted" ? "accepted" : "running", acceptedSeq: persisted.acceptedSeq };
	}

	private withMutation<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.mutationTail;
		let resolveTail!: () => void;
		this.mutationTail = new Promise<void>((resolve) => (resolveTail = resolve));
		return previous.then(operation).finally(resolveTail);
	}

	async accept(operationId: string): Promise<OperationAccepted> {
		return this.withMutation(async () => {
			const validatedOperationId = boundedRequired(operationId, 256);
			if (!validatedOperationId) throw new Error("Operation ID must be a non-empty bounded string");
			this.restoreOperationState(await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }));
			if (this.operations.has(validatedOperationId)) throw new Error(`Operation ${validatedOperationId} was already accepted`);
			const active = [...this.operations.values()].find((operation) => operation.state === "accepted" || operation.state === "running" || operation.state === "suspended");
			if (active) throw new Error(`Session is busy with ${active.operationId}`);
			const accepted = { operationId: validatedOperationId, sessionRevision: this.revision + 1, eventSeq: this.eventSeq + 1 };
			await this.persistOperation({ operationId: validatedOperationId, state: "accepted", kind: "turn", acceptedSeq: accepted.eventSeq, revision: accepted.sessionRevision, eventSeq: accepted.eventSeq });
			this.freshOperationId = validatedOperationId;
			return accepted;
		});
	}

	async run(operationId: string, command: CommandV2): Promise<void> {
		if (command.command === "turn/abort") {
			await this.abortImmediately(operationId);
			return;
		}
		const previous = this.executionTail;
		let release!: () => void;
		this.executionTail = new Promise<void>((resolve) => (release = resolve));
		try {
			await previous;
			await this.runUnlocked(operationId, command);
		} finally {
			release();
		}
	}

	async abort(operationId: string): Promise<void> {
		await this.abortImmediately(operationId);
	}

	private async abortImmediately(operationId: string): Promise<void> {
		if (this.disposed) throw new Error("Session runtime is disposed");
		let abortHarness = false;
		let cancelledBeforeExecution = false;
		await this.withMutation(async () => {
			const operation = this.operations.get(operationId);
			if (!operation || (operation.state !== "accepted" && operation.state !== "running"))
				throw new Error(`Operation ${operationId} is not active`);
			if (operation.state === "running") {
				abortHarness = true;
				return;
			}
			await this.persistOperation({ ...operation, state: "aborted", revision: this.revision + 1, eventSeq: this.eventSeq + 1 });
			this.operationId = undefined;
			this.freshOperationId = undefined;
			cancelledBeforeExecution = true;
		});
		if (abortHarness) {
			const result = await this.definition.harness.abort();
			if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
		}
		if (cancelledBeforeExecution) await this.definition.extensionHost?.onOperationTerminal({ id: operationId, type: "turn/start" }, "aborted");
	}

	private async runUnlocked(operationId: string, command: CommandV2): Promise<void> {
		if (this.disposed) throw new Error("Session runtime is disposed");
		try {
		let cancelledBeforeExecution = false;
		await this.withMutation(async () => {
			this.restoreOperationState(await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }));
			const operation = this.operations.get(operationId);
			if (!operation) throw new Error(`Operation ${operationId} was not accepted`);
			if (operation.state === "aborted") {
				cancelledBeforeExecution = true;
				return;
			}
			if (operation.state !== "accepted") throw new Error(`Operation ${operationId} was already run`);
			this.operationId = operationId;
			this.freshOperationId = undefined;
			await this.persistOperation({ ...operation, state: "running", revision: this.revision + 1, eventSeq: this.eventSeq + 1 });
		});
		if (cancelledBeforeExecution) return;
		const harness = this.definition.harness;
		const runCommand: CommandNameV2 = command.command;
		const payload = commandPayload(command);
		const extensionHost = this.definition.extensionHost;
		await extensionHost?.onOperationAccepted({ id: _operationId, type: runCommand });
		try {
			if (runCommand === "turn/start") {
				await harness.prompt(text);
				if (this.autoName) await this.generateName();
			} else if (runCommand === "turn/resume") {
				const result = await harness.resume();
				if (!result.ok) throw new Error(result.error.message);
				if (result.value.kind === "failed") throw new Error(result.value.error.message);
			} else if (runCommand === "turn/steer") await harness.steer(text);
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
				await harness.session.setName(this.sessionName);
				this.nameRevision += 1;
			} else if (runCommand === "session/name/generate") {
				const generated =
					typeof payload.name === "string" && payload.name.trim().length > 0 ? payload.name.trim() : undefined;
				if (generated === undefined) await this.generateName();
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
			await extensionHost?.onOperationTerminal({ id: _operationId, type: runCommand }, "failed");
			throw error;
		}
		} catch (error) {
			terminalOutcome = "failed";
			await notifyTerminal("failed");
			throw error;
		}
		} catch (error) {
			terminalOutcome = "failed";
			await notifyTerminal("failed");
			throw error;
		}
		} catch (error) {
			terminalOutcome = "failed";
			await notifyTerminal("failed");
			throw error;
		}
		void this.autoName;
		await extensionHost?.onOperationTerminal({ id: _operationId, type: runCommand }, "completed");
		this.revision += 1;
		this.eventSeq += 1;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.definition.goalContinuation?.close();
		await this.definition.harness.close();
		this.onDispose?.();
	}
}

export function createCodingAgentV2Service(
	models: Models,
	definitions: readonly CodingAgentV2SessionDefinition[],
	options?: CodingAgentV2ServiceOptions,
): CodingAgentV2Service {
	const byId = new Map(definitions.map((definition) => [definition.metadata.id, definition]));
	const knownIds = new Set(
		[...(options?.initialSessions ?? []), ...definitions.map((definition) => definition.metadata)].map((item) => item.id),
	);
	const runtimes = new Map<string, CodingAgentV2RuntimeImpl>();
	const opening = new Map<string, Promise<CodingAgentV2RuntimeImpl>>();
	const creatingIds = new Set<string>();
	const sessionLocks = new Map<string, Promise<void>>();
	const withSessionLock = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
		const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => (release = resolve));
		sessionLocks.set(sessionId, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId);
		}
	};
	const sessionFactory = options?.createSession;
	const sessionDeleter = options?.deleteSession;
	return {
		listSessions: async () =>
			options?.listSessions
				? structuredClone(await options.listSessions())
				: [...byId.values()].map((definition) => structuredClone(definition.metadata)),
		listModels: async () => Promise.all(models.getModels().map((model) => modelMetadata(models, model))),
		createSession: sessionFactory
			? async (payload) => withSessionLock("__create__", async () => {
					if (typeof payload.id === "string" && knownIds.has(payload.id))
						throw new Error(`Session ${payload.id} already exists`);
					const definition = await sessionFactory(payload);
					if (creatingIds.has(definition.metadata.id)) throw new Error(`Session ${definition.metadata.id} is being created`);
					if (byId.has(definition.metadata.id) || knownIds.has(definition.metadata.id)) {
						await definition.harness.close().catch(() => undefined);
						throw new Error(`Session ${definition.metadata.id} already exists`);
					}
					creatingIds.add(definition.metadata.id);
					try {
					const model = await definition.harness.getModel();
					let runtime!: CodingAgentV2RuntimeImpl;
					runtime = new CodingAgentV2RuntimeImpl(definition, models, model, () => {
						if (runtimes.get(definition.metadata.id) === runtime) runtimes.delete(definition.metadata.id);
					});
					byId.set(definition.metadata.id, definition);
					knownIds.add(definition.metadata.id);
					runtimes.set(definition.metadata.id, runtime);
					return { sessionId: definition.metadata.id, runtime };
					} finally {
						creatingIds.delete(definition.metadata.id);
					}
				})
			: undefined,
		deleteSession: sessionDeleter
			? async (sessionId) => withSessionLock(sessionId, async () => {
					if (creatingIds.has(sessionId)) throw new Error(`Session ${sessionId} is being created`);
					if (!byId.has(sessionId) && !knownIds.has(sessionId)) throw new Error(`Unknown session ${sessionId}`);
					await sessionDeleter(sessionId);
					const runtime = runtimes.get(sessionId);
					try {
						if (runtime) await runtime.dispose();
					} finally {
						runtimes.delete(sessionId);
						byId.delete(sessionId);
						knownIds.delete(sessionId);
					}
				})
			: undefined,
		openSession: (sessionId) => withSessionLock(sessionId, async () => {
			if (creatingIds.has(sessionId)) throw new Error(`Session ${sessionId} is being created`);
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
