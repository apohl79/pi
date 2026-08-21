import type { AgentHarness, AgentMessage, Entry, GoalManager, LaneRecord } from "@earendil-works/pi-agent-core";
import type { Model, Models, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type {
	CommandNameV2,
	CommandV2,
	JsonValue,
	ModelMetadata,
	OperationAccepted,
	SessionMetadataV2,
	SessionSnapshotV2,
	SessionPhaseV2,
} from "@earendil-works/pi-protocol";
import { MAX_V2_ARRAY_ITEMS, MAX_V2_JSON_DEPTH, MAX_V2_STRING_LENGTH } from "@earendil-works/pi-protocol";
import type { ServerRuntimeExtensionHost } from "./extension-host.ts";

const OPERATION_ENTRY = "v2_operation";
type PersistedOperation = {
	operationId: string;
	state: "accepted" | "running" | "complete" | "failed" | "aborted" | "suspended";
	kind: string;
	acceptedSeq: number;
	revision: number;
	eventSeq: number;
};

function finiteTimestamp(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function boundedString(value: unknown): string {
	return typeof value === "string" ? value.slice(0, MAX_V2_STRING_LENGTH) : "";
}

function boundedRequired(value: unknown, max = MAX_V2_STRING_LENGTH): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
	return value;
}

function redactText(value: string): string {
	return value
		.replace(/\bBearer\s+[^\s"'`,;}\]]+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
		.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]")
		.replace(/\bgh[pour]_[A-Za-z0-9]{20,}\b/g, "[redacted]")
		.replace(/\bghs_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]")
		.replace(/([\"']?(?:api[_ -]?key|access[_ -]?token|token|secret|password|authorization|credential)[\"']?)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)/gi, "$1=[redacted]")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_V2_STRING_LENGTH);
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>(), redact = false): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return redact ? redactText(value) : boundedString(value);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (depth >= MAX_V2_JSON_DEPTH || typeof value !== "object") return "[truncated]";
	if (ancestors.has(value)) return "[cycle]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.slice(0, MAX_V2_ARRAY_ITEMS).map((item) => jsonValue(item, depth + 1, ancestors, redact));
		return Object.fromEntries(
			Object.entries(value)
				.slice(0, MAX_V2_ARRAY_ITEMS)
				.map(([key, item]) => [boundedString(key), /api[_ -]?key|token|secret|password|authorization|credential/i.test(key) ? "[redacted]" : jsonValue(item, depth + 1, ancestors, redact)]),
		) as JsonValue;
	} finally {
		ancestors.delete(value);
	}
}

function usage(value: Usage | undefined): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} | undefined {
	if (!value) return undefined;
	return {
		input: finiteNonNegative(value.input),
		output: finiteNonNegative(value.output),
		cacheRead: finiteNonNegative(value.cacheRead),
		cacheWrite: finiteNonNegative(value.cacheWrite),
		totalTokens: finiteNonNegative(value.totalTokens),
		cost: {
			input: finiteNonNegative(value.cost.input),
			output: finiteNonNegative(value.cost.output),
			cacheRead: finiteNonNegative(value.cost.cacheRead),
			cacheWrite: finiteNonNegative(value.cost.cacheWrite),
			total: finiteNonNegative(value.cost.total),
		},
	};
}

function aggregateUsage(records: readonly LaneRecord[], branchEntryIds: ReadonlySet<string>): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
} {
	const add = (left: number, right: number): number => {
		const sum = left + right;
		if (!Number.isFinite(sum)) return right < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
		return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, sum));
	};
	const signed = (value: number): number => (Number.isFinite(value) ? value : 0);
	const totals = records
		.filter(
			(record): record is Extract<LaneRecord, { type: "usage" }> =>
				record.type === "usage" && (record.entryId === undefined || branchEntryIds.has(record.entryId)),
		)
		.reduce(
			(total, record) => ({
				input: add(total.input, signed(record.usage.input)),
				output: add(total.output, signed(record.usage.output)),
				cacheRead: add(total.cacheRead, signed(record.usage.cacheRead)),
				cacheWrite: add(total.cacheWrite, signed(record.usage.cacheWrite)),
				costUsd: add(total.costUsd, signed(record.usage.cost.total)),
			}),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
		);
	return {
		input: Math.max(0, Math.floor(totals.input)),
		output: Math.max(0, Math.floor(totals.output)),
		cacheRead: Math.max(0, Math.floor(totals.cacheRead)),
		cacheWrite: Math.max(0, Math.floor(totals.cacheWrite)),
		costUsd: Math.max(0, totals.costUsd),
	};
}

function contentParts(message: AgentMessage): Array<Record<string, unknown>> {
	const redact =
		(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "deferred" || message.stopReason === "aborted")) ||
		(message.role === "toolResult" && message.isError === true);
	if (typeof message !== "object" || message === null || !Array.isArray((message as { content?: unknown }).content)) {
		return [{ type: "text", text: redact ? redactText(boundedString(messageText(message))) : boundedString(messageText(message)) }];
	}
	return (message as { content: unknown[] }).content.slice(0, MAX_V2_ARRAY_ITEMS).flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const candidate = part as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") return [{ type: "text", text: redact ? redactText(boundedString(candidate.text)) : boundedString(candidate.text) }];
		if (candidate.type === "thinking" && typeof candidate.thinking === "string") return [{ type: "thinking", thinking: redact ? redactText(boundedString(candidate.thinking)) : boundedString(candidate.thinking) }];
		if (candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string") {
			const mimeType = boundedRequired(candidate.mimeType, 127);
			if (!mimeType || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) return [];
			return [{ type: "image", data: boundedString(candidate.data), mimeType }];
		}
		if (candidate.type === "toolCall") {
			const toolCallId = boundedRequired(candidate.id, 256);
			const toolName = boundedRequired(candidate.name, 256);
			if (!toolCallId || !toolName) return [];
			return [{ type: "toolCall", toolCallId, toolName, input: jsonValue(candidate.arguments, 0, new Set<object>(), redact) }];
		}
		return [];
	});
}

function queueContent(message: AgentMessage): Array<Record<string, unknown>> {
	const parts = contentParts(message).filter((part) => part.type === "text" || part.type === "image");
	return parts.length > 0 ? parts : [{ type: "text", text: boundedString(messageText(message)) }];
}

function targetMessage(target: unknown): AgentMessage {
	if (typeof target === "object" && target !== null && "message" in target) return (target as { message: AgentMessage }).message;
	return { role: "user", content: "", timestamp: 0 };
}

function transcriptItem(entry: Extract<Entry, { type: "message" }>): SessionSnapshotV2["transcript"][number] | undefined {
	const message = entry.message;
	const timestamp = finiteTimestamp(entry.timestamp);
	const entryId = boundedRequired(entry.id, 256);
	if (!entryId) return undefined;
	if (message.role === "user") return { id: entryId, role: "user", content: contentParts(message) as never, timestamp };
	if (message.role === "assistant") {
		const provider = boundedRequired(message.provider, 256);
		const model = boundedRequired(message.model, 256);
		if (!provider || !model) return undefined;
		const base = {
			id: entryId,
			role: "assistant" as const,
			content: contentParts(message) as never,
			model: { provider, id: model },
			...(message.responseModel === undefined ? {} : (() => {
				const responseModel = boundedRequired(message.responseModel, 256);
				return responseModel ? { responseModel } : {};
			})()),
			...(usage(message.usage) === undefined ? {} : { usage: usage(message.usage) }),
			timestamp,
		};
		if (message.stopReason === "aborted") return { ...base, status: "aborted", stopReason: "aborted", ...(message.errorMessage ? { errorMessage: redactText(boundedString(message.errorMessage)) } : {}) };
		if (message.stopReason === "error" || message.stopReason === "deferred") return { ...base, status: "error", stopReason: "error", ...(message.errorMessage ? { errorMessage: redactText(boundedString(message.errorMessage)) } : {}) };
		if (message.stopReason === "pending") return { ...base, status: "streaming" };
		return { ...base, status: "complete", stopReason: message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop" };
	}
	if (message.role === "toolResult") {
		const toolCallId = boundedRequired(message.toolCallId, 256);
		const toolName = boundedRequired(message.toolName, 256);
		if (!toolCallId || !toolName) return undefined;
		return {
			id: entryId,
			role: "tool",
			toolCallId,
			toolName,
			input: null,
			content: contentParts(message) as never,
			...(message.details === undefined ? {} : { details: jsonValue(message.details, 0, new Set<object>(), message.isError === true) }),
			...(usage(message.usage) === undefined ? {} : { usage: usage(message.usage) }),
			timestamp,
			status: message.isError ? "error" : "complete",
			isError: message.isError,
		};
	}
	return undefined;
}

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
}

export interface CodingAgentV2Runtime {
	snapshot(): Promise<SessionSnapshotV2>;
	accept(operationId: string): Promise<OperationAccepted>;
	run(operationId: string, command: CommandV2): Promise<void>;
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
		const [thinkingLevel, persistedName, entries, queueRecords, compaction] = await Promise.all([
			this.definition.harness.getThinkingLevel(),
			this.definition.harness.session.getName(),
			this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }),
			this.definition.harness.session.findRecords({ order: "oldestFirst" }),
			this.definition.harness.getCompactionSettings(),
		]);
		this.restoreOperationState(entries);
		const open = await this.definition.harness.session.findOpenOperations("main", { limit: 1 });
		const laneOperation = open[0];
		const transcript = entries
			.filter((entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message")
			.slice(-MAX_V2_ARRAY_ITEMS)
			.map((entry) => transcriptItem(entry))
			.filter((item): item is SessionSnapshotV2["transcript"][number] => item !== undefined);
		const cancelled = new Set(queueRecords.filter((record) => record.type === "queue_cancelled").map((record) => record.entryId));
		const queued = queueRecords.filter((record) => record.type === "queue_enqueued" && !cancelled.has(record.target.id));
		const queuedSteer = queued
			.filter((record) => record.type === "queue_enqueued" && record.queue === "steer")
			.slice(-MAX_V2_ARRAY_ITEMS)
			.map((record) => {
				const id = boundedRequired(record.target.id, 256);
				return id ? { id, content: queueContent(targetMessage(record.target)).slice(0, MAX_V2_ARRAY_ITEMS) as never, createdAt: finiteTimestamp(record.timestamp) } : undefined;
			})
			.filter((record): record is { id: string; content: never; createdAt: number } => record !== undefined);
		const queuedFollowUp = queued
			.filter((record) => record.type === "queue_enqueued" && record.queue === "followUp")
			.slice(-MAX_V2_ARRAY_ITEMS)
			.map((record) => {
				const id = boundedRequired(record.target.id, 256);
				return id ? { id, content: queueContent(targetMessage(record.target)).slice(0, MAX_V2_ARRAY_ITEMS) as never, createdAt: finiteTimestamp(record.timestamp) } : undefined;
			})
			.filter((record): record is { id: string; content: never; createdAt: number } => record !== undefined);
		const active = this.activeOperation(laneOperation);
		const phase: SessionPhaseV2 = laneOperation === undefined
			? active?.state === "suspended"
				? "suspended"
				: active?.state === "accepted"
					? "turn"
					: "idle"
			: laneOperation.intent.kind === "compaction"
				? "compaction"
				: laneOperation.intent.kind === "run"
					? "turn"
					: "suspended";
		const goal = await this.definition.goals?.read();
		const sessionName = persistedName ?? this.sessionName;
		const branchEntryIds = new Set(entries.map((entry) => entry.id));
		const totals = aggregateUsage(queueRecords, branchEntryIds);
		const contextWindow = Math.max(1, this.model.contextWindow);
		const reserveTokens = Math.max(0, compaction.reserveTokens);
		const latestUsage = queueRecords
			.filter(
				(record): record is Extract<LaneRecord, { type: "usage" }> =>
					record.type === "usage" &&
					record.cause === "assistant" &&
					(record.entryId === undefined || branchEntryIds.has(record.entryId)),
			)
			.at(-1)?.usage;
		const currentTokens = Math.min(contextWindow, Math.floor(finiteNonNegative(latestUsage?.totalTokens)));
		return {
			id: this.definition.metadata.id,
			...(sessionName === undefined
				? {}
				: { name: boundedString(sessionName), ...(this.nameSource === undefined ? {} : { nameSource: this.nameSource }) }),
			nameRevision: this.nameRevision,
			revision: this.revision,
			eventSeq: this.eventSeq,
			phase,
			...(active === undefined ? {} : { activeOperation: active }),
			model: { provider: boundedString(this.model.provider), id: boundedString(this.model.id) },
			thinkingLevel,
			transcript,
			queues: { steer: queuedSteer, followUp: queuedFollowUp },
			...(goal === undefined ? {} : { goal }),
			agents: [],
			usage: {
				input: totals.input,
				output: totals.output,
				cacheRead: totals.cacheRead,
				cacheWrite: totals.cacheWrite,
				...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
				pricingState: "known",
			},
			context: {
				inputTokens: currentTokens,
				contextWindow,
				usedPercentage: (currentTokens / contextWindow) * 100,
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

	private async runUnlocked(operationId: string, command: CommandV2): Promise<void> {
		if (this.disposed) throw new Error("Session runtime is disposed");
		try {
		await this.withMutation(async () => {
			this.restoreOperationState(await this.definition.harness.session.findEntriesOnBranch({ order: "oldestFirst" }));
			const operation = this.operations.get(operationId);
			if (!operation) throw new Error(`Operation ${operationId} was not accepted`);
			if (operation.state !== "accepted") throw new Error(`Operation ${operationId} was already run`);
			this.operationId = operationId;
			this.freshOperationId = undefined;
			await this.persistOperation({ ...operation, state: "running", revision: this.revision + 1, eventSeq: this.eventSeq + 1 });
		});
		const harness = this.definition.harness;
		const runCommand: CommandNameV2 = command.command;
		const payload = commandPayload(command);
		const extensionHost = this.definition.extensionHost;
		let terminalNotified = false;
		let terminalOutcome = "completed";
		const notifyTerminal = async (outcome: string): Promise<void> => {
			if (terminalNotified) return;
			try {
				await extensionHost?.onOperationTerminal({ id: operationId, type: runCommand }, outcome);
				terminalNotified = true;
			} catch (error) {
				if (outcome !== "completed") terminalNotified = true;
				throw error;
			}
		};
		try {
			await extensionHost?.onOperationAccepted({ id: operationId, type: runCommand });
		} catch (error) {
			terminalOutcome = "failed";
			await notifyTerminal("failed");
			throw error;
		}
		try {
		const unwrap = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
			if (!result.ok) throw result.error instanceof Error ? result.error : new Error(String(result.error));
			return result.value as T;
		};
		if (runCommand === "turn/start") {
			const outcome = unwrap(await harness.prompt(requireText(command, requirePayload(command))));
			if ("kind" in outcome) {
				if (outcome.kind === "failed") { terminalOutcome = "failed"; throw new Error(outcome.error.message); }
				if (outcome.kind === "aborted") terminalOutcome = "aborted";
				if (outcome.kind === "suspended") terminalOutcome = "suspended";
			}
		} else if (runCommand === "turn/resume") {
			const outcome = unwrap(await harness.resume());
			if ("kind" in outcome) {
				if (outcome.kind === "failed") { terminalOutcome = "failed"; throw new Error(outcome.error.message); }
				if (outcome.kind === "aborted") terminalOutcome = "aborted";
				if (outcome.kind === "suspended") terminalOutcome = "suspended";
			}
		} else if (runCommand === "turn/steer") unwrap(await harness.steer(requireText(command, requirePayload(command))));
		else if (runCommand === "turn/followUp") unwrap(await harness.followUp(requireText(command, requirePayload(command))));
		else if (runCommand === "turn/abort") {
			unwrap(await harness.abort());
			terminalOutcome = "aborted";
		}
		else if (runCommand === "turn/rollback") {
			const turns = typeof payload.turns === "number" ? payload.turns : 1;
			unwrap(await harness.rollback(turns));
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
		} else if (runCommand === "goal/pause") {
			if (!this.definition.goals) throw new Error("Goals are not configured");
			await this.definition.goals.pause();
		} else if (runCommand === "goal/resume") {
			if (!this.definition.goals) throw new Error("Goals are not configured");
			await this.definition.goals.resume();
		}
		else if (runCommand === "session/model/set") {
			const provider = requireBoundedNonEmptyString(command, payload.provider, "provider");
			const id = requireBoundedNonEmptyString(command, payload.id, "id");
			const model = this.models.getModel(provider, id);
			if (!model) throw new Error(`Unknown model ${provider}/${id}`);
			await harness.setModel(model);
			this.model = model;
		} else if (runCommand === "session/thinking/set") {
			if (typeof payload.level !== "string") throw new Error("session/thinking/set requires level");
			const supported = this.model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : ["off"];
			if (!supported.includes(payload.level)) throw new Error(`Unsupported thinking level: ${payload.level}`);
			await harness.setThinkingLevel(payload.level as ThinkingLevel);
		} else if (runCommand === "session/name/set") {
			if (payload.name !== null && typeof payload.name !== "string")
				throw new Error("session/name/set requires name or null");
			const nextName = payload.name === null ? undefined : sessionNameValue(command, payload.name);
			await harness.session.setName(nextName);
			this.sessionName = nextName;
			this.nameSource = payload.name === null ? undefined : "explicit";
			this.nameRevision += 1;
		} else if (runCommand === "session/name/generate") {
			const generated =
				typeof payload.name === "string" && payload.name.trim().length > 0
					? sessionNameValue(command, payload.name)
					: "Untitled session";
			if (this.nameSource !== "explicit") {
				await harness.session.setName(generated);
				this.sessionName = generated;
				this.nameSource = "generated";
				this.nameRevision += 1;
			}
		} else if (runCommand === "session/name/auto/set") {
			if (typeof payload.enabled !== "boolean") throw new Error("session/name/auto/set requires enabled");
			this.autoName = payload.enabled;
		}
		} catch (error) {
			terminalOutcome = "failed";
			await notifyTerminal("failed");
			throw error;
		}
		void this.autoName;
		await this.withMutation(async () => {
			const operation = this.operations.get(operationId);
			if (!operation) return;
			const state = runCommand === "turn/abort" ? "aborted" : terminalOutcome === "suspended" ? "suspended" : terminalOutcome === "aborted" ? "aborted" : "complete";
			await this.persistOperation({ ...operation, state, revision: this.revision + 1, eventSeq: this.eventSeq + 1 });
			this.operationId = undefined;
			this.freshOperationId = undefined;
		});
		await notifyTerminal(terminalOutcome);
		} catch (error) {
			try {
				await this.withMutation(async () => {
				const operation = this.operations.get(operationId);
				if (operation && (operation.state === "accepted" || operation.state === "running"))
					await this.persistOperation({ ...operation, state: "failed", revision: this.revision + 1, eventSeq: this.eventSeq + 1 });
				this.operationId = undefined;
				this.freshOperationId = undefined;
				});
			} finally {
				terminalOutcome = "failed";
				await notifyTerminal("failed").catch(() => undefined);
			}
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.definition.harness.close();
		this.onDispose?.();
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
				let runtime!: CodingAgentV2RuntimeImpl;
				runtime = new CodingAgentV2RuntimeImpl(definition, models, model, () => {
					if (runtimes.get(sessionId) === runtime) runtimes.delete(sessionId);
				});
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
