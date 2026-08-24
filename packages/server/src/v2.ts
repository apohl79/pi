import { createHash, randomUUID } from "node:crypto";
import {
	type ClientHelloV2,
	type CommandV2,
	decodeCbor,
	type EventEnvelopeV2,
	encodeServerMessageV2,
	FrameDecoder,
	type InteractiveResourceV2,
	type ModelMetadata,
	type OperationAccepted,
	type OperationRecordV2,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
	type SessionMetadataV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { InMemoryV2AgentRegistry, type V2AgentRegistry } from "./agents.ts";
import {
	InMemoryV2AppCredentialStore,
	InMemoryV2AppRegistry,
	type V2App,
	type V2AppAuthComplete,
	type V2AppAuthStart,
	type V2AppCredentialStore,
	type V2AppRegistry,
} from "./apps.ts";
import { InMemoryV2BlobStore, type V2BlobStore } from "./blobs.ts";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import {
	type DiagnosticBundleProjections,
	type DiagnosticCapsule,
	type DiagnosticContentStore,
	type DiagnosticIntegrityCheck,
	type DiagnosticIntegrityProvider,
	type DiagnosticRepairProvider,
	type DiagnosticRepairResult,
	type DiagnosticRuntimeManifest,
	type DiagnosticValue,
	type ForensicRecorder,
	findDiagnosticClockDiscontinuities,
	InMemoryForensicRecorder,
	verifyDiagnosticBundle,
} from "./diagnostics.ts";
import { LocalV2FileReferenceService, type V2FileReferenceService } from "./files.ts";
import { BlobV2ImageService, type V2ImageService } from "./images.ts";
import { InMemoryV2InputRegistry, type V2InputRegistry } from "./inputs.ts";
import type { PiServerListener } from "./listener.ts";
import { InMemoryV2OperationStore, type V2OperationStore } from "./operation-store.ts";
import { InMemoryV2PlanRegistry, type V2PlanRegistry } from "./plans.ts";
import { InMemoryV2PluginRegistry, type V2PluginRegistry } from "./plugins.ts";
import { InMemoryV2ProcessRegistry, type V2ProcessChange, type V2ProcessRegistry } from "./processes.ts";
import { toProtocolJsonValue } from "./protocol.ts";
import type { MaybePromise } from "./types.ts";
import {
	aggregateV2UsageEntries,
	InMemoryV2UsageLedger,
	type V2UsageFilter,
	type V2UsageLedger,
} from "./usage-ledger.ts";
import { UnavailableV2WebService, type V2WebOperation, type V2WebService } from "./web.ts";

function fileReferencePayload(file: Awaited<ReturnType<V2FileReferenceService["resolve"]>>): Record<string, unknown> {
	return {
		reference: file.reference,
		path: file.path,
		kind: file.kind,
		...(file.size === undefined ? {} : { size: file.size }),
		...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
	};
}

function modelIdFamily(id: string): string {
	return id.replace(/-latest$/, "").replace(/-\d{8}$/, "");
}

function modelReferencesResolveToSameCatalogModel(
	provider: string,
	leftId: string,
	rightId: string,
	models: readonly ModelMetadata[],
): boolean {
	if (leftId === rightId) return true;
	const providerModels = models.filter((model) => model.provider === provider);
	const left = providerModels.find((model) => model.id === leftId);
	const right = providerModels.find((model) => model.id === rightId);
	if (!left || !right || modelIdFamily(left.id) !== modelIdFamily(right.id)) return false;
	const alias = (id: string): boolean => id.endsWith("-latest") || !/-\d{8}$/.test(id);
	return alias(left.id) || alias(right.id);
}

export interface PiSessionRuntimeEventV2 {
	readonly sessionId: string;
	readonly event: "item_completed" | "tool_started" | "tool_completed" | "plugin_diagnostic";
	readonly payload: Record<string, unknown>;
	readonly operationId?: string;
}

export interface PiSessionRuntimeV2 {
	snapshot(): MaybePromise<SessionSnapshotV2>;
	/** Optional daemon-owned prompt templates and skills available to this attached session. */
	listInteractiveResources?(): MaybePromise<readonly InteractiveResourceV2[]>;
	recordBash?(message: {
		command: string;
		output: string;
		exitCode?: number;
		cancelled: boolean;
		truncated: boolean;
		excludeFromContext: boolean;
	}): Promise<void>;
	/** Optional durable tree projection for runtimes that retain branch ancestry. */
	readTree?(): MaybePromise<unknown>;
	/** Optional full portable JSONL export for runtimes with durable entry storage. */
	exportJsonl?(): MaybePromise<string>;
	accept(operationId: string, command?: CommandV2): Promise<OperationAccepted>;
	/** Subscribe to provider/tool lifecycle events that must reach detached clients. */
	onEvent?(listener: (event: PiSessionRuntimeEventV2) => void): () => void;
	/** Cancel an exact queued steer/follow-up item when the runtime exposes queue control. */
	cancelQueued?(entryId: string): Promise<void>;
	/** Mark an accepted operation failed when durable operation acceptance cannot be persisted. */
	rejectAccepted?(operationId: string, error: string): Promise<void>;
	run(operationId: string, command: CommandV2): Promise<void>;
	dispose(): Promise<void>;
}

export interface PiServerServiceV2 {
	listSessions(): Promise<SessionMetadataV2[]>;
	listModels(): Promise<ModelMetadata[]>;
	openSession(sessionId: string): Promise<PiSessionRuntimeV2>;
	createSession?(options: Record<string, unknown>): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }>;
	importSession?(options: {
		readonly jsonl: string;
		readonly cwd?: string;
	}): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }>;
	forkSession?(
		sourceSessionId: string,
		options: Record<string, unknown>,
	): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }>;
	deleteSession?(sessionId: string): Promise<void>;
}

export interface PiServerV2Options {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	daemonInstanceId?: string;
	onError?: (error: Error) => void;
	diagnostics?: ForensicRecorder;
	diagnosticContent?: DiagnosticContentStore;
	integrity?: DiagnosticIntegrityProvider;
	repairSafe?: DiagnosticRepairProvider;
	runtimeManifest?: DiagnosticRuntimeManifest;
	operationStore?: V2OperationStore;
	processes?: V2ProcessRegistry;
	blobs?: V2BlobStore;
	agents?: V2AgentRegistry;
	apps?: V2AppRegistry;
	appCredentials?: V2AppCredentialStore;
	plans?: V2PlanRegistry;
	inputs?: V2InputRegistry;
	files?: V2FileReferenceService;
	web?: V2WebService;
	images?: V2ImageService;
	plugins?: V2PluginRegistry;
	usage?: V2UsageLedger;
}

type V2ConnectionState = {
	id: string;
	connection: ByteConnection;
	decoder: FrameDecoder;
	sessions: Map<string, PiSessionRuntimeV2>;
	controlSessions: Set<string>;
	ready: boolean;
	closed: boolean;
	clientDiagnostics?: ClientHelloV2["diagnostics"];
	handshakeTimeout: NodeJS.Timeout;
};

const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
const MAX_EVENT_HISTORY = 256;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function objectPayload(command: CommandV2): Record<string, unknown> {
	if (typeof command.payload !== "object" || command.payload === null || Array.isArray(command.payload)) return {};
	return command.payload as Record<string, unknown>;
}

function parseForkTurns(value: unknown): "none" | "all" | number {
	if (value === "none" || value === "all") return value;
	if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 32) return value;
	throw new Error("agent/spawn forkTurns must be none, all, or an integer from 1 to 32");
}

function processIdFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const processId = payload.processId ?? command.operationId;
	if (typeof processId !== "string" || processId.length === 0) throw new Error("processId is required");
	return processId;
}

function agentIdFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const agentId = payload.agentId ?? command.operationId;
	if (typeof agentId !== "string" || agentId.length === 0) throw new Error("agentId is required");
	return agentId;
}

function requestIdFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const requestId = payload.requestId ?? command.requestId ?? command.operationId;
	if (typeof requestId !== "string" || requestId.length === 0) throw new Error("requestId is required");
	return requestId;
}

const GOAL_STATUSES = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

function validateGoalCommand(command: CommandV2, payload: Record<string, unknown>): void {
	if (command.command === "goal/create") {
		if (typeof payload.objective !== "string") throw new Error("goal/create objective must be a string");
		if (payload.objective.trim().length === 0) throw new Error("goal/create objective must not be empty");
		if (payload.tokenBudget !== undefined) {
			if (typeof payload.tokenBudget !== "number") throw new Error("goal/create tokenBudget must be a number");
			if (!Number.isSafeInteger(payload.tokenBudget) || payload.tokenBudget < 0)
				throw new Error("goal/create tokenBudget must be a non-negative safe integer");
		}
		return;
	}
	if (command.command !== "goal/update") return;
	if (payload.status !== undefined) {
		if (typeof payload.status !== "string") throw new Error("goal/update status must be a string");
		if (!GOAL_STATUSES.has(payload.status)) throw new Error("goal/update status is invalid");
	}
	for (const field of ["tokensUsed", "tokenBudget"] as const) {
		if (payload[field] === undefined) continue;
		if (typeof payload[field] !== "number") throw new Error(`goal/update ${field} must be a number`);
		if (!Number.isSafeInteger(payload[field]) || payload[field] < 0)
			throw new Error(`goal/update ${field} must be a non-negative safe integer`);
	}
	if (payload.activeTimeSeconds !== undefined) {
		if (typeof payload.activeTimeSeconds !== "number")
			throw new Error("goal/update activeTimeSeconds must be a number");
		if (!Number.isFinite(payload.activeTimeSeconds) || payload.activeTimeSeconds < 0)
			throw new Error("goal/update activeTimeSeconds must be non-negative");
	}
}

function validateTurnCommand(command: CommandV2, payload: Record<string, unknown>): void {
	if (command.command === "turn/rollback" && payload.turns !== undefined) {
		if (typeof payload.turns !== "number") throw new Error("turn/rollback turns must be a number");
		if (!Number.isSafeInteger(payload.turns) || payload.turns < 1)
			throw new Error("turn/rollback turns must be a positive safe integer");
	}
	if (command.command !== "turn/navigate") return;
	if (payload.targetId !== null && typeof payload.targetId !== "string")
		throw new Error("turn/navigate targetId must be a string or null");
	for (const field of ["summarize"] as const) {
		if (payload[field] !== undefined && typeof payload[field] !== "boolean")
			throw new Error(`turn/navigate ${field} must be a boolean`);
	}
	for (const field of ["customInstructions", "label"] as const) {
		if (payload[field] !== undefined && typeof payload[field] !== "string")
			throw new Error(`turn/navigate ${field} must be a string`);
	}
}

function validateSessionLabelCommand(command: CommandV2, payload: Record<string, unknown>): void {
	if (command.command !== "session/label/set") return;
	if (typeof payload.entryId !== "string" || payload.entryId.length === 0)
		throw new Error("session/label/set requires a non-empty entryId");
	if (payload.label !== null && typeof payload.label !== "string")
		throw new Error("session/label/set requires a label or null");
}

function referenceFrom(command: CommandV2, payload: Record<string, unknown>): string {
	const reference = payload.reference ?? command.operationId;
	if (typeof reference !== "string" || reference.length === 0) throw new Error("file reference is required");
	return reference;
}

export class PiServerV2 {
	readonly id: string;
	private readonly listeners: readonly PiServerListener[];
	private readonly service: PiServerServiceV2;
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly daemonInstanceId: string | undefined;
	private readonly diagnostics: ForensicRecorder;
	private readonly diagnosticContent: DiagnosticContentStore | undefined;
	private readonly integrity: DiagnosticIntegrityProvider | undefined;
	private readonly repairSafe: DiagnosticRepairProvider | undefined;
	private readonly runtimeManifest: DiagnosticRuntimeManifest;
	private readonly diagnosticCapsules = new Map<string, DiagnosticCapsule>();
	private readonly operationStore: V2OperationStore;
	private readonly processes: V2ProcessRegistry;
	private readonly unsubscribeProcessChanges: (() => void) | undefined;
	private readonly blobs: V2BlobStore;
	private readonly agents: V2AgentRegistry;
	private readonly apps: V2AppRegistry;
	private readonly appCredentials: V2AppCredentialStore;
	private readonly plans: V2PlanRegistry;
	private readonly inputs: V2InputRegistry;
	private readonly unsubscribeInputChanges: (() => void) | undefined;
	private readonly files: V2FileReferenceService;
	private readonly web: V2WebService;
	private readonly images: V2ImageService;
	private readonly plugins: V2PluginRegistry;
	private readonly usage: V2UsageLedger;
	private readonly connections = new Set<V2ConnectionState>();
	private readonly controls = new Map<string, string>();
	private readonly runtimes = new Set<PiSessionRuntimeV2>();
	private readonly eventHistory = new Map<string, EventEnvelopeV2[]>();
	private readonly eventDeliveryTails = new WeakMap<V2ConnectionState, Promise<void>>();
	private readonly sessionOperationTails = new Map<string, Promise<void>>();
	private readonly agentWatches = new Set<string>();
	private readonly operations = new Map<string, OperationRecordV2>();
	private readonly pendingRecoveryReports = new Map<string, OperationRecordV2[]>();
	private readonly pendingRequests = new Map<string, CommandV2>();
	private readonly completionControllers = new Map<string, AbortController>();
	private readonly disposedRuntimes = new WeakSet<PiSessionRuntimeV2>();
	private readonly runtimeEventUnsubscribers = new WeakMap<PiSessionRuntimeV2, () => void>();
	private diagnosticsDegradedNotified = false;
	private lastEmittedStoreIntegrityHealthy: boolean | undefined;
	private closing = false;
	private started = false;
	private restored = false;

	constructor(service: PiServerServiceV2, options: PiServerV2Options) {
		this.service = service;
		this.listeners = options.listeners;
		this.id = options.serverId ?? randomUUID();
		this.maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.onError = options.onError;
		this.daemonInstanceId = options.daemonInstanceId;
		const diagnostics = options.diagnostics ?? new InMemoryForensicRecorder();
		this.diagnostics = {
			record: async (event: Parameters<ForensicRecorder["record"]>[0]) => {
				const recorded = await diagnostics.record({
					...event,
					...(event.daemonInstanceId === undefined && this.daemonInstanceId !== undefined
						? { daemonInstanceId: this.daemonInstanceId }
						: {}),
				});
				this.notifyDiagnosticsDegraded(event);
				return recorded;
			},
			read: (afterSeq?: number) => diagnostics.read(afterSeq),
			...(diagnostics.isDegraded === undefined ? {} : { isDegraded: () => diagnostics.isDegraded?.() === true }),
		};
		this.diagnosticContent = options.diagnosticContent;
		this.integrity = options.integrity;
		this.repairSafe = options.repairSafe;
		this.runtimeManifest = options.runtimeManifest ?? {
			schemaVersion: 1,
			runtime: `node ${process.version}`,
			platform: process.platform,
			arch: process.arch,
		};
		this.operationStore = options.operationStore ?? new InMemoryV2OperationStore();
		this.processes = options.processes ?? new InMemoryV2ProcessRegistry();
		this.unsubscribeProcessChanges = this.processes.onChange?.((change) => {
			void this.broadcastProcessChange(change);
		});
		this.blobs = options.blobs ?? new InMemoryV2BlobStore();
		this.agents = options.agents ?? new InMemoryV2AgentRegistry();
		this.apps = options.apps ?? new InMemoryV2AppRegistry();
		this.appCredentials = options.appCredentials ?? new InMemoryV2AppCredentialStore();
		this.plans = options.plans ?? new InMemoryV2PlanRegistry();
		this.inputs = options.inputs ?? new InMemoryV2InputRegistry();
		this.unsubscribeInputChanges = this.inputs.onChange?.((request) => {
			void this.broadcastInputRequestChange(request);
		});
		this.files =
			options.files ?? new LocalV2FileReferenceService({ projectRoot: process.cwd(), allowAbsolute: false });
		this.web = options.web ?? new UnavailableV2WebService();
		this.images = options.images ?? new BlobV2ImageService(this.files, this.blobs);
		this.plugins = options.plugins ?? new InMemoryV2PluginRegistry();
		this.usage = options.usage ?? new InMemoryV2UsageLedger();
	}

	private async broadcastInputRequestChange(request: Awaited<ReturnType<V2InputRegistry["read"]>>): Promise<void> {
		try {
			const runtime = await this.service.openSession(request.sessionId);
			this.trackRuntime(runtime);
			await this.broadcastEvent(request.sessionId, runtime, { request }, undefined, "input_request_updated");
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	get addresses(): readonly string[] {
		return this.listeners.flatMap((listener) => (listener.address === undefined ? [] : [listener.address]));
	}

	async start(): Promise<this> {
		if (this.started || this.closing) throw new Error("PiServerV2 is already started or closing");
		const started: PiServerListener[] = [];
		try {
			await this.restoreStore();
			for (const listener of this.listeners) {
				await listener.start((connection) => this.accept(connection));
				started.push(listener);
			}
			this.started = true;
			return this;
		} catch (error) {
			await Promise.allSettled(started.map((listener) => listener.close()));
			throw error;
		}
	}

	private async restoreStore(): Promise<void> {
		if (this.restored) return;
		const stored = await this.operationStore.load();
		for (const operation of stored.operations) {
			const recovered =
				operation.state === "accepted" || operation.state === "running"
					? {
							...operation,
							state: "suspended" as const,
							error: "Operation was suspended by daemon restart",
						}
					: operation;
			this.operations.set(recovered.operationId, recovered);
			if (recovered !== operation) {
				await this.operationStore.putOperation(recovered);
				const reports = this.pendingRecoveryReports.get(recovered.sessionId) ?? [];
				reports.push(recovered);
				this.pendingRecoveryReports.set(recovered.sessionId, reports);
			}
		}
		for (const event of stored.events) {
			const history = this.eventHistory.get(event.sessionId) ?? [];
			history.push(event);
			if (history.length > MAX_EVENT_HISTORY) history.splice(0, history.length - MAX_EVENT_HISTORY);
			this.eventHistory.set(event.sessionId, history);
		}
		this.restored = true;
	}

	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void connection.close();
			return { onData: () => {}, onClose: () => {}, onError: (error) => this.reportError(error) };
		}
		const state = this.createConnectionState(connection);
		this.connections.add(state);
		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.disconnect(state),
			onError: (error) => {
				this.reportError(error);
				void Promise.resolve(state.connection.close()).then(() => this.disconnect(state));
			},
		};
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.unsubscribeInputChanges?.();
		this.unsubscribeProcessChanges?.();
		await Promise.all(this.listeners.map((listener) => listener.close()));
		await Promise.all(Array.from(this.connections, (state) => this.closeConnection(state)));
		for (const controller of this.completionControllers.values()) controller.abort();
		this.completionControllers.clear();
		await Promise.all(Array.from(this.runtimes, (runtime) => this.disposeRuntime(runtime)));
		this.runtimes.clear();
		await this.agents.dispose?.();
		this.started = false;
	}

	private async broadcastProcessChange(change: V2ProcessChange): Promise<void> {
		try {
			const runtime = await this.service.openSession(change.process.sessionId);
			this.trackRuntime(runtime);
			await this.broadcastEvent(
				change.process.sessionId,
				runtime,
				{ process: change.process },
				undefined,
				change.kind === "output" ? "process_output" : "process_terminal",
			);
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private createConnectionState(connection: ByteConnection): V2ConnectionState {
		const state = {
			id: randomUUID(),
			connection,
			decoder: new FrameDecoder({ maxFrameLength: this.maxFrameLength }),
			sessions: new Map<string, PiSessionRuntimeV2>(),
			controlSessions: new Set<string>(),
			ready: false,
			closed: false,
			handshakeTimeout: undefined as unknown as NodeJS.Timeout,
		};
		state.handshakeTimeout = setTimeout(() => {
			void this.failProtocol(state, "invalid_request", "Handshake timeout");
		}, this.handshakeTimeoutMs);
		state.handshakeTimeout.unref();
		return state;
	}

	private receive(state: V2ConnectionState, chunk: Uint8Array): void {
		if (state.closed) return;
		try {
			for (const frame of state.decoder.push(chunk)) this.dispatch(state, parseClientMessageV2(decodeCbor(frame)));
		} catch (error) {
			void this.failProtocol(state, "invalid_request", error instanceof Error ? error.message : String(error));
		}
	}

	private dispatch(state: V2ConnectionState, message: ReturnType<typeof parseClientMessageV2>): void {
		if (!state.ready) {
			if (message.type !== "hello") return void this.failProtocol(state, "invalid_request", "Expected v2 hello");
			void this.handshake(state, message);
			return;
		}
		if (message.type !== "request")
			return void this.failProtocol(state, "invalid_request", "Hello is only valid once");
		void this.handleRequest(state, message.id, message.request);
	}

	private async handshake(state: V2ConnectionState, message: ClientHelloV2): Promise<void> {
		if (message.version !== PROTOCOL_V2_VERSION)
			return void (await this.failProtocol(state, "unsupported_version", "Unsupported protocol version"));
		try {
			state.clientDiagnostics = message.diagnostics;
			const snapshot: ServerSnapshotV2 = {
				serverId: this.id,
				protocolVersion: PROTOCOL_V2_VERSION,
				revision: 0,
				eventSeq: 0,
				sessions: await this.service.listSessions(),
				models: await this.service.listModels(),
			};
			state.ready = true;
			clearTimeout(state.handshakeTimeout);
			await this.send(state, { type: "hello", version: PROTOCOL_V2_VERSION, connectionId: state.id, snapshot });
			if (message.lastEvent) await this.replayEvents(state, message.lastEvent);
		} catch (error) {
			await this.failProtocol(state, "internal_error", error instanceof Error ? error.message : String(error));
		}
	}

	private async replayEvents(
		state: V2ConnectionState,
		cursor: { sessionId: string; eventSeq: number },
	): Promise<void> {
		const events = this.eventHistory.get(cursor.sessionId) ?? [];
		const retainedFrom = events[0]?.seq;
		if (retainedFrom !== undefined && cursor.eventSeq < retainedFrom - 1) {
			const runtime = await this.service.openSession(cursor.sessionId);
			const session = await this.snapshotForSession(cursor.sessionId, runtime);
			await this.send(state, {
				type: "event",
				sessionId: cursor.sessionId,
				seq: retainedFrom - 1,
				revision: session.revision,
				event: "session_snapshot",
				payload: {
					reason: "event_cursor_expired",
					requestedEventSeq: cursor.eventSeq,
					retainedFrom,
					snapshot: toProtocolJsonValue(session),
				},
			});
		}
		for (const event of events) {
			if (event.seq > cursor.eventSeq) await this.send(state, event);
		}
	}

	private async handleRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestKey = `${state.id}:${id}`;
		if (this.pendingRequests.has(requestKey)) return void (await this.rejectDuplicateRequest(state, id, command));
		this.pendingRequests.set(requestKey, command);
		try {
			await this.recordProtocolDiagnostic({
				kind: "protocol_command_received",
				severity: "debug",
				outcome: "started",
				traceId: command.operationId ?? command.requestId ?? id,
				spanId: id,
				...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
				...(command.operationId === undefined ? {} : { operationId: command.operationId }),
				...(this.daemonInstanceId === undefined ? {} : { daemonInstanceId: this.daemonInstanceId }),
				payload: { command: command.command, requestId: id },
			});
			if (command.command === "session/create") return void (await this.createSession(state, id, command));
			if (command.command === "session/import") return void (await this.importSession(state, id, command));
			if (command.command === "session/fork") return void (await this.forkSession(state, id, command));
			if (command.command === "session/delete") return void (await this.deleteSession(state, id, command));
			if (command.command === "session/list")
				return void (await this.sendResponse(state, id, {
					command: command.command,
					sessions: await this.service.listSessions(),
				}));
			if (command.command === "model/list")
				return void (await this.sendResponse(state, id, {
					command: command.command,
					models: await this.service.listModels(),
				}));
			if (command.command === "resource/list") return void (await this.listInteractiveResources(state, id, command));
			if (command.command === "operation/read") return void (await this.readOperation(state, id, command));
			if (command.command === "session/attach") return void (await this.attach(state, id, command));
			if (command.command === "session/read") return void (await this.readSession(state, id, command));
			if (command.command === "session/tree/read") return void (await this.readSessionTree(state, id, command));
			if (command.command === "session/export") return void (await this.exportSession(state, id, command));
			if (command.command === "session/bash/record") return void (await this.recordBash(state, id, command));
			if (command.command === "goal/read") return void (await this.readGoal(state, id, command));
			if (command.command === "turn/queue/cancel") return void (await this.cancelQueued(state, id, command));
			if (command.command === "process/start") return void (await this.startProcess(state, id, command));
			if (command.command === "process/list") return void (await this.listProcesses(state, id, command));
			if (command.command === "process/write") return void (await this.writeProcess(state, id, command));
			if (command.command === "process/read") return void (await this.readProcess(state, id, command));
			if (command.command === "process/wait") return void (await this.waitProcess(state, id, command));
			if (command.command === "process/terminate") return void (await this.terminateProcess(state, id, command));
			if (command.command === "blob/put") return void (await this.putBlob(state, id, command));
			if (command.command === "blob/read") return void (await this.readBlob(state, id, command));
			if (command.command === "blob/stat") return void (await this.statBlob(state, id, command));
			if (command.command === "agent/spawn") return void (await this.spawnAgent(state, id, command));
			if (command.command === "agent/list") return void (await this.listAgents(state, id, command));
			if (command.command === "agent/wait") return void (await this.waitAgent(state, id, command));
			if (command.command === "agent/message") return void (await this.messageAgent(state, id, command));
			if (command.command === "agent/followUp") return void (await this.followUpAgent(state, id, command));
			if (command.command === "agent/interrupt") return void (await this.interruptAgent(state, id, command));
			if (command.command === "app/list") return void (await this.listApps(state, id, command));
			if (command.command === "app/read") return void (await this.readApp(state, id, command));
			if (command.command === "app/auth/start") return void (await this.startAppAuth(state, id, command));
			if (command.command === "app/auth/complete") return void (await this.completeAppAuth(state, id, command));
			if (command.command === "plan/read") return void (await this.readPlan(state, id, command));
			if (command.command === "plan/update") return void (await this.updatePlan(state, id, command));
			if (command.command === "plan/clear") return void (await this.clearPlan(state, id, command));
			if (command.command === "input/request/read") return void (await this.readInputRequest(state, id, command));
			if (command.command === "input/request/respond")
				return void (await this.respondInputRequest(state, id, command));
			if (command.command === "input/request/cancel")
				return void (await this.cancelInputRequest(state, id, command));
			if (command.command === "filesystem/complete") return void (await this.completeFiles(state, id, command));
			if (command.command === "filesystem/reference/resolve")
				return void (await this.resolveFile(state, id, command));
			if (command.command === "filesystem/reference/read") return void (await this.readFile(state, id, command));
			if (command.command === "web") return void (await this.webRequest(state, id, command));
			if (command.command === "image/view") return void (await this.viewImage(state, id, command));
			if (command.command === "image/generate") return void (await this.generateImage(state, id, command));
			if (command.command === "diagnostics/status") return void (await this.diagnosticsStatus(state, id, command));
			if (command.command === "diagnostics/timeline")
				return void (await this.diagnosticsTimeline(state, id, command));
			if (command.command === "diagnostics/export") return void (await this.diagnosticsExport(state, id, command));
			if (command.command === "diagnostics/verify") return void (await this.diagnosticsVerify(state, id, command));
			if (command.command === "diagnostics/doctor") return void (await this.diagnosticsDoctor(state, id, command));
			if (command.command === "marketplace/add") return void (await this.addMarketplace(state, id, command));
			if (command.command === "marketplace/list") return void (await this.listMarketplaces(state, id, command));
			if (command.command === "marketplace/upgrade") return void (await this.upgradeMarketplace(state, id, command));
			if (command.command === "marketplace/remove") return void (await this.removeMarketplace(state, id, command));
			if (command.command === "plugin/list") return void (await this.listPlugins(state, id, command));
			if (command.command === "plugin/read") return void (await this.readPlugin(state, id, command));
			if (command.command === "plugin/install") return void (await this.installPlugin(state, id, command));
			if (command.command === "plugin/upgrade") return void (await this.upgradePlugin(state, id, command));
			if (command.command === "plugin/uninstall") return void (await this.uninstallPlugin(state, id, command));
			if (command.command === "plugin/enable") return void (await this.setPluginEnabled(state, id, command, true));
			if (command.command === "plugin/disable") return void (await this.setPluginEnabled(state, id, command, false));
			if (command.command === "usage/read") return void (await this.readUsage(state, id, command));
			if (command.command === "session/detach") return void (await this.detach(state, id, command));
			if (
				command.command === "turn/start" ||
				command.command === "turn/steer" ||
				command.command === "turn/followUp" ||
				command.command === "turn/abort" ||
				command.command === "turn/resume" ||
				command.command === "turn/rollback" ||
				command.command === "turn/navigate" ||
				command.command === "turn/compact" ||
				command.command === "goal/create" ||
				command.command === "goal/update" ||
				command.command === "goal/pause" ||
				command.command === "goal/resume" ||
				command.command === "session/model/set" ||
				command.command === "session/thinking/set" ||
				command.command === "session/steering-mode/set" ||
				command.command === "session/follow-up-mode/set" ||
				command.command === "session/compaction/set" ||
				command.command === "session/retry/set" ||
				command.command === "session/name/set" ||
				command.command === "session/name/generate" ||
				command.command === "session/name/auto/set" ||
				command.command === "session/label/set"
			)
				return void (await this.runSessionCommand(state, id, command));
			await this.sendError(
				state,
				id,
				"not_implemented",
				`Command ${command.command} is not implemented in the v2 seam`,
			);
		} catch (error) {
			await this.sendError(state, id, "request_failed", error instanceof Error ? error.message : String(error));
		}
	}

	private async listInteractiveResources(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("resource/list requires sessionId");
		const runtime = state.sessions.get(command.sessionId);
		if (!runtime) throw new Error(`Session ${command.sessionId} is not attached`);
		await this.sendResponse(state, id, {
			command: command.command,
			resources: (await runtime.listInteractiveResources?.()) ?? [],
		});
	}

	private async recordBash(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/bash/record requires sessionId");
		this.requireControl(state, command.sessionId);
		const runtime = state.sessions.get(command.sessionId);
		if (!runtime) throw new Error(`Session ${command.sessionId} is not attached`);
		if (runtime.recordBash === undefined) throw new Error("session/bash/record is not supported by this session");
		const payload = objectPayload(command);
		if (typeof payload.command !== "string" || typeof payload.output !== "string")
			throw new Error("session/bash/record requires command and output");
		if (typeof payload.cancelled !== "boolean" || typeof payload.truncated !== "boolean")
			throw new Error("session/bash/record requires cancelled and truncated flags");
		if (
			payload.exitCode !== undefined &&
			(typeof payload.exitCode !== "number" || !Number.isSafeInteger(payload.exitCode) || payload.exitCode < 0)
		)
			throw new Error("session/bash/record exitCode must be a non-negative integer");
		await runtime.recordBash({
			command: payload.command,
			output: payload.output,
			...(typeof payload.exitCode === "number" ? { exitCode: payload.exitCode } : {}),
			cancelled: payload.cancelled,
			truncated: payload.truncated,
			excludeFromContext: payload.excludeFromContext === true,
		});
		await this.sendResponse(state, id, { command: command.command });
	}

	private async rejectDuplicateRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		await this.recordProtocolDiagnostic({
			kind: "protocol_command_completed",
			severity: "error",
			outcome: "error",
			traceId: command.operationId ?? command.requestId ?? id,
			spanId: id,
			...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
			...(command.operationId === undefined ? {} : { operationId: command.operationId }),
			...(this.daemonInstanceId === undefined ? {} : { daemonInstanceId: this.daemonInstanceId }),
			payload: {
				command: command.command,
				requestId: id,
				errorCode: "duplicate_request_id",
				error: "A request with this id is already in flight",
			},
		});
		if (state.closed) return;
		try {
			await this.send(state, {
				type: "response",
				id,
				ok: false,
				error: { code: "duplicate_request_id", message: "A request with this id is already in flight" },
			});
		} catch {
			this.disconnect(state);
		}
	}

	private async createSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!this.service.createSession) throw new Error("session/create is not supported by this service");
		const payload = objectPayload(command);
		for (const field of ["id", "name", "cwd"]) {
			if (payload[field] !== undefined && typeof payload[field] !== "string")
				throw new Error(`session/create ${field} must be a string`);
		}
		const created = await this.service.createSession(payload);
		if (state.sessions.has(created.sessionId)) throw new Error(`Session ${created.sessionId} is already attached`);
		this.trackRuntime(created.runtime);
		state.sessions.set(created.sessionId, created.runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(created.sessionId, created.runtime)),
		});
	}

	private async importSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!this.service.importSession) throw new Error("session/import is not supported by this service");
		const payload = objectPayload(command);
		if (typeof payload.jsonl !== "string") throw new Error("session/import requires JSONL content");
		if (payload.cwd !== undefined && typeof payload.cwd !== "string")
			throw new Error("session/import cwd must be a string");
		const imported = await this.service.importSession({
			jsonl: payload.jsonl,
			...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
		});
		if (state.sessions.has(imported.sessionId)) throw new Error(`Session ${imported.sessionId} is already attached`);
		this.trackRuntime(imported.runtime);
		state.sessions.set(imported.sessionId, imported.runtime);
		this.claimControl(state, imported.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(imported.sessionId, imported.runtime)),
		});
	}

	private async deleteSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/delete requires sessionId");
		this.requireControl(state, command.sessionId);
		if (!this.service.deleteSession) throw new Error("session/delete is not supported by this service");
		await this.service.deleteSession(command.sessionId);
		const runtime = state.sessions.get(command.sessionId);
		state.sessions.delete(command.sessionId);
		this.releaseControlFor(state, command.sessionId);
		if (runtime && !this.hasRuntimeReference(runtime)) await this.disposeRuntime(runtime);
		await this.sendResponse(state, id, { command: command.command, sessionId: command.sessionId });
	}

	private async forkSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/fork requires sessionId");
		this.requireControl(state, command.sessionId);
		if (!this.service.forkSession) throw new Error("session/fork is not supported by this service");
		const payload = objectPayload(command);
		if (payload.scope !== undefined && payload.scope !== "branch" && payload.scope !== "tree")
			throw new Error("session/fork scope must be branch or tree");
		if (payload.position !== undefined && payload.position !== "before" && payload.position !== "at")
			throw new Error("session/fork position must be before or at");
		for (const field of ["id", "name", "cwd", "entryId"])
			if (payload[field] !== undefined && typeof payload[field] !== "string")
				throw new Error(`session/fork ${field} must be a string`);
		const forked = await this.service.forkSession(command.sessionId, payload);
		if (state.sessions.has(forked.sessionId)) throw new Error(`Session ${forked.sessionId} is already attached`);
		this.trackRuntime(forked.runtime);
		state.sessions.set(forked.sessionId, forked.runtime);
		this.claimControl(state, forked.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(forked.sessionId, forked.runtime)),
		});
	}

	private async attach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/attach requires sessionId");
		const payload = objectPayload(command);
		const mode = payload.mode === undefined ? "control" : payload.mode;
		if (mode !== "control" && mode !== "observer") throw new Error("session/attach mode must be control or observer");
		const runtime = await this.service.openSession(command.sessionId);
		if (mode === "control") this.claimControl(state, command.sessionId);
		else this.releaseControlFor(state, command.sessionId);
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			lease: mode,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
		const recoveryReports = this.pendingRecoveryReports.get(command.sessionId);
		if (recoveryReports !== undefined) {
			this.pendingRecoveryReports.delete(command.sessionId);
			for (const operation of recoveryReports) {
				await this.broadcastEvent(
					command.sessionId,
					runtime,
					{
						state: operation.state,
						reason: operation.error ?? "Operation was suspended by daemon restart",
					},
					operation.operationId,
					"recovery_report",
				);
			}
		}
	}

	private async readSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/read requires sessionId");
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
	}

	private async readSessionTree(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/tree/read requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		if (runtime.readTree === undefined) throw new Error("Session tree is unavailable");
		await this.sendResponse(state, id, {
			command: command.command,
			tree: toProtocolJsonValue(await runtime.readTree()),
		});
	}

	private async exportSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/export requires sessionId");
		this.requireControl(state, command.sessionId);
		const runtime = state.sessions.get(command.sessionId);
		if (!runtime) throw new Error(`Session ${command.sessionId} is not attached`);
		if (runtime.exportJsonl === undefined) throw new Error("Session export is unavailable");
		const jsonl = await runtime.exportJsonl();
		if (jsonl.length > 1_048_576) throw new Error("Session export exceeds the V2 response limit");
		await this.sendResponse(state, id, { command: command.command, jsonl });
	}

	private async readGoal(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("goal/read requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		const snapshot = await runtime.snapshot();
		await this.sendResponse(
			state,
			id,
			snapshot.goal === undefined ? { command: command.command } : { command: command.command, goal: snapshot.goal },
		);
	}

	private async startProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("process/start requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.command !== "string") throw new Error("process/start requires command");
		if (payload.cwd !== undefined && typeof payload.cwd !== "string")
			throw new Error("process/start cwd must be a string");
		if (payload.pty !== undefined && typeof payload.pty !== "boolean")
			throw new Error("process/start pty must be a boolean");
		let env: Record<string, string> | undefined;
		if (payload.env !== undefined) {
			if (typeof payload.env !== "object" || payload.env === null || Array.isArray(payload.env))
				throw new Error("process/start env must be an object");
			env = {};
			for (const [name, value] of Object.entries(payload.env)) {
				if (typeof value !== "string") throw new Error(`process/start env ${name} must be a string`);
				env[name] = value;
			}
		}
		const process = await this.processes.start({
			sessionId: command.sessionId,
			command: payload.command,
			...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
			...(env === undefined ? {} : { env }),
			...(payload.pty === undefined ? {} : { pty: payload.pty }),
		});
		await this.recordProtocolDiagnostic({
			kind: "process_started",
			severity: "info",
			outcome: "started",
			traceId: command.operationId ?? process.processId,
			spanId: id,
			processInstanceId: process.processId,
			sessionId: command.sessionId,
			payload: { pty: process.pty },
		});
		await this.sendResponse(state, id, {
			command: command.command,
			process: process as unknown as Record<string, unknown>,
		});
	}

	private async listProcesses(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("process/list requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			processes: (await this.processes.list(command.sessionId)) as unknown as Record<string, unknown>[],
		});
	}

	private async writeProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		const snapshot = await this.processes.getSnapshot(processId);
		this.requireProcessSession(state, command, snapshot.sessionId);
		this.requireControl(state, snapshot.sessionId);
		if (payload.eof !== undefined && typeof payload.eof !== "boolean")
			throw new Error("process/write eof must be a boolean");
		const input = payload.input === undefined ? (payload.eof === true ? "" : undefined) : payload.input;
		if (typeof input !== "string") throw new Error("process/write requires input unless eof is true");
		const output = await this.processes.write(processId, input, {
			...(payload.eof === undefined ? {} : { eof: payload.eof }),
		});
		await this.diagnostics.record({
			kind: "process_input_written",
			severity: "info",
			outcome: "ok",
			traceId: command.operationId ?? processId,
			spanId: id,
			processInstanceId: processId,
			sessionId: snapshot.sessionId,
			payload: { byteLength: Buffer.byteLength(input, "utf8"), cursor: output.cursor },
		});
		await this.sendResponse(state, id, {
			command: command.command,
			output,
		});
	}

	private async readProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		const snapshot = await this.processes.getSnapshot(processId);
		this.requireProcessSession(state, command, snapshot.sessionId);
		if (payload.cursor !== undefined && typeof payload.cursor !== "number")
			throw new Error("process/read cursor must be a number");
		if (typeof payload.cursor === "number" && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0))
			throw new Error("process/read cursor must be a non-negative safe integer");
		const cursor = typeof payload.cursor === "number" ? payload.cursor : 0;
		const output = await this.processes.read(processId, cursor);
		await this.diagnostics.record({
			kind: "process_output_read",
			severity: "debug",
			outcome: "ok",
			traceId: command.operationId ?? processId,
			spanId: id,
			processInstanceId: processId,
			payload: { cursor, nextCursor: output.cursor, byteLength: Buffer.byteLength(output.output, "utf8") },
		});
		await this.sendResponse(state, id, {
			command: command.command,
			output,
		});
	}

	private async waitProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		const snapshot = await this.processes.getSnapshot(processId);
		this.requireProcessSession(state, command, snapshot.sessionId);
		const process = await this.processes.wait(processId);
		await this.diagnostics.record({
			kind: "process_waited",
			severity: "info",
			outcome: "ok",
			traceId: command.operationId ?? processId,
			spanId: id,
			processInstanceId: processId,
			sessionId: process.sessionId,
			payload: { state: process.state, exitCode: process.exitCode },
		});
		await this.sendResponse(state, id, {
			command: command.command,
			process,
		});
	}

	private async terminateProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		const snapshot = await this.processes.getSnapshot(processId);
		this.requireProcessSession(state, command, snapshot.sessionId);
		this.requireControl(state, snapshot.sessionId);
		const process = await this.processes.terminate(processId);
		await this.diagnostics.record({
			kind: "process_terminated",
			severity: "info",
			outcome: "ok",
			traceId: command.operationId ?? processId,
			spanId: id,
			processInstanceId: processId,
			sessionId: snapshot.sessionId,
			payload: { previousState: snapshot.state, state: process.state, exitCode: process.exitCode },
		});
		await this.sendResponse(state, id, {
			command: command.command,
			process,
		});
	}

	private async putBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.data !== "string" || typeof payload.mimeType !== "string")
			throw new Error("blob/put requires data and mimeType");
		const encoding = payload.encoding === "base64" ? "base64" : payload.encoding === "utf8" ? "utf8" : undefined;
		if (!encoding) throw new Error("blob/put encoding must be utf8 or base64");
		if (
			encoding === "base64" &&
			(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload.data) ||
				Buffer.from(payload.data, "base64").toString("base64") !== payload.data)
		)
			throw new Error("blob/put base64 data is invalid");
		const data = encoding === "base64" ? Buffer.from(payload.data, "base64") : Buffer.from(payload.data, "utf8");
		await this.sendResponse(state, id, {
			command: command.command,
			blob: await this.blobs.put(data, payload.mimeType),
		});
	}

	private async readBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.digest !== "string") throw new Error("blob/read requires digest");
		const data = await this.blobs.read(payload.digest);
		await this.sendResponse(state, id, {
			command: command.command,
			digest: payload.digest,
			encoding: "base64",
			data: Buffer.from(data).toString("base64"),
		});
	}

	private async statBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.digest !== "string") throw new Error("blob/stat requires digest");
		await this.sendResponse(state, id, { command: command.command, blob: await this.blobs.stat(payload.digest) });
	}

	private async spawnAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("agent/spawn requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.taskName !== "string" || typeof payload.taskMessage !== "string")
			throw new Error("agent/spawn requires taskName and taskMessage");
		if (payload.parentPath !== undefined && typeof payload.parentPath !== "string")
			throw new Error("agent/spawn parentPath must be a string");
		if (
			payload.model !== undefined &&
			(typeof payload.model !== "object" || payload.model === null || Array.isArray(payload.model))
		)
			throw new Error("agent/spawn model must be an object");
		if (payload.role !== undefined && typeof payload.role !== "string")
			throw new Error("agent/spawn role must be a string");
		const modelPayload =
			typeof payload.model === "object" && payload.model !== null && !Array.isArray(payload.model)
				? (payload.model as Record<string, unknown>)
				: {};
		if (modelPayload.provider !== undefined && typeof modelPayload.provider !== "string")
			throw new Error("agent/spawn model.provider must be a string");
		if (modelPayload.id !== undefined && typeof modelPayload.id !== "string")
			throw new Error("agent/spawn model.id must be a string");
		const inheritedModel = (await (await this.service.openSession(command.sessionId)).snapshot()).model;
		const availableModels = await this.service.listModels();
		const sameAsParent =
			typeof modelPayload.provider === "string" &&
			typeof modelPayload.id === "string" &&
			modelPayload.provider === inheritedModel.provider &&
			modelReferencesResolveToSameCatalogModel(
				modelPayload.provider,
				modelPayload.id,
				inheritedModel.id,
				availableModels,
			);
		const agent = await this.agents.spawn({
			sessionId: command.sessionId,
			parentPath: typeof payload.parentPath === "string" ? payload.parentPath : "/root",
			taskName: payload.taskName,
			taskMessage: payload.taskMessage,
			...(typeof payload.role === "string" ? { role: payload.role } : {}),
			...(payload.forkTurns === undefined ? {} : { forkTurns: parseForkTurns(payload.forkTurns) }),
			model: {
				provider: typeof modelPayload.provider === "string" ? modelPayload.provider : "inherit",
				id: typeof modelPayload.id === "string" ? modelPayload.id : "inherit",
			},
			modelResolution: Object.keys(modelPayload).length === 0 || sameAsParent ? "inherited" : "explicit",
		});
		await this.sendResponse(state, id, { command: command.command, agent });
		const runtime = state.sessions.get(command.sessionId);
		if (runtime) {
			await this.broadcastEvent(command.sessionId, runtime, { agent }, undefined, "agent_updated");
			this.watchAgent(command.sessionId, runtime, agent.id);
		}
	}

	private async listAgents(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("agent/list requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			agents: await this.agents.list(command.sessionId),
		});
	}

	private async waitAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		if (payload.timeoutMs !== undefined && typeof payload.timeoutMs !== "number")
			throw new Error("agent/wait timeoutMs must be a number");
		if (typeof payload.timeoutMs === "number" && (!Number.isSafeInteger(payload.timeoutMs) || payload.timeoutMs < 0))
			throw new Error("agent/wait timeoutMs must be a non-negative safe integer");
		this.requireSessionReference(state, (await this.agents.getSnapshot(agentId)).sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			agent: await this.agents.wait(agentId, typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined),
		});
	}

	private async messageAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		this.requireControl(state, (await this.agents.getSnapshot(agentId)).sessionId);
		if (typeof payload.message !== "string") throw new Error("agent/message requires message");
		const message = payload.message;
		await this.agents.message(agentId, message);
		await this.sendResponse(state, id, { command: command.command, agentId });
		const sessionId = (await this.agents.getSnapshot(agentId)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) await this.broadcastEvent(sessionId, runtime, { agentId, message }, undefined, "agent_message");
	}

	private async followUpAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		this.requireControl(state, (await this.agents.getSnapshot(agentId)).sessionId);
		if (typeof payload.message !== "string") throw new Error("agent/followUp requires message");
		const agent = await this.agents.followUp(agentId, payload.message);
		await this.sendResponse(state, id, {
			command: command.command,
			agent,
		});
		const sessionId = (await this.agents.getSnapshot(agentId)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
	}

	private async interruptAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		this.requireControl(state, (await this.agents.getSnapshot(agentIdFrom(command, payload))).sessionId);
		const agent = await this.agents.interrupt(agentIdFrom(command, payload));
		await this.sendResponse(state, id, {
			command: command.command,
			agent,
		});
		const sessionId = (await this.agents.getSnapshot(agent.id)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) {
			await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
			this.watchAgent(sessionId, runtime, agent.id);
		}
	}

	private async snapshotForSession(sessionId: string, runtime: PiSessionRuntimeV2): Promise<SessionSnapshotV2> {
		const snapshot = await runtime.snapshot();
		const agents = await this.agents.list(sessionId);
		const plan = await this.plans.read(sessionId);
		const pendingInputRequestId = await this.inputs.pendingForSession(sessionId);
		return {
			...snapshot,
			...(pendingInputRequestId === undefined ? {} : { phase: "awaitingInput" as const }),
			...(agents.length === 0 ? {} : { agents: [...agents] }),
			...(plan === undefined ? {} : { plan }),
			queues: {
				...snapshot.queues,
				...(pendingInputRequestId === undefined ? {} : { pendingInputRequestId }),
			},
		};
	}

	private watchAgent(sessionId: string, runtime: PiSessionRuntimeV2, agentId: string): void {
		const key = `${sessionId}:${agentId}`;
		if (this.agentWatches.has(key)) return;
		this.agentWatches.add(key);
		void this.agents
			.wait(agentId)
			.then(async (agent) => {
				if (!this.closing) await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
			})
			.catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))))
			.finally(() => this.agentWatches.delete(key));
	}

	private async readPlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/read requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const plan = await this.plans.read(command.sessionId);
		await this.sendResponse(
			state,
			id,
			plan === undefined ? { command: command.command } : { command: command.command, plan },
		);
	}

	private async cancelQueued(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("turn/queue/cancel requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.entryId !== "string" || payload.entryId.length === 0)
			throw new Error("turn/queue/cancel requires entryId");
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		if (runtime.cancelQueued === undefined) throw new Error("Queued message cancellation is not supported");
		await runtime.cancelQueued(payload.entryId);
		await this.sendResponse(state, id, { command: command.command, entryId: payload.entryId, cancelled: true });
		await this.broadcastEvent(
			command.sessionId,
			runtime,
			{ snapshot: await runtime.snapshot() },
			undefined,
			"session_snapshot",
		);
	}

	private async updatePlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/update requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (!Array.isArray(payload.items)) throw new Error("plan/update requires items");
		if (payload.version !== undefined && typeof payload.version !== "number")
			throw new Error("plan/update version must be a number");
		if (typeof payload.version === "number" && (!Number.isSafeInteger(payload.version) || payload.version < 1))
			throw new Error("plan/update version must be a positive safe integer");
		const items = payload.items as Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
		const plan = await this.plans.update(command.sessionId, {
			items,
			...(typeof payload.version === "number" ? { version: payload.version } : {}),
		});
		await this.sendResponse(state, id, { command: command.command, plan });
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.broadcastEvent(command.sessionId, runtime, { plan }, undefined, "plan_updated");
	}

	private async clearPlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/clear requires sessionId");
		this.requireControl(state, command.sessionId);
		if (!this.plans.clear) throw new Error("plan/clear is not supported by this registry");
		await this.plans.clear(command.sessionId);
		const runtime = state.sessions.get(command.sessionId) ?? (await this.service.openSession(command.sessionId));
		this.trackRuntime(runtime);
		state.sessions.set(command.sessionId, runtime);
		await this.sendResponse(state, id, { command: command.command, cleared: true });
		await this.broadcastEvent(command.sessionId, runtime, { plan: null }, undefined, "plan_updated");
	}

	private async readInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestId = requestIdFrom(command, objectPayload(command));
		await this.sendResponse(state, id, { command: command.command, request: await this.inputs.read(requestId) });
	}

	private async respondInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const requestId = requestIdFrom(command, payload);
		const request = await this.inputs.read(requestId);
		this.requireControl(state, request.sessionId);
		if (typeof payload.answers !== "object" || payload.answers === null || Array.isArray(payload.answers))
			throw new Error("input/request/respond requires answers");
		const answers = Object.fromEntries(
			Object.entries(payload.answers as Record<string, unknown>).map(([key, value]) => {
				if (typeof value !== "string") throw new Error(`Answer ${key} must be a string`);
				return [key, value];
			}),
		);
		const responded = await this.inputs.respond(requestId, answers);
		await this.sendResponse(state, id, {
			command: command.command,
			request: responded,
		});
		const runtime = state.sessions.get(request.sessionId);
		const snapshot = runtime === undefined ? undefined : await runtime.snapshot();
		if (
			runtime !== undefined &&
			snapshot !== undefined &&
			(snapshot.phase === "awaitingInput" || snapshot.persistence.recoveryState === "needsResolution")
		) {
			const operationId = randomUUID();
			await runtime.accept(operationId);
			void runtime
				.run(operationId, { command: "turn/resume", sessionId: request.sessionId, payload: {} })
				.catch(() => undefined);
		}
	}

	private async cancelInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestId = requestIdFrom(command, objectPayload(command));
		const request = await this.inputs.read(requestId);
		this.requireControl(state, request.sessionId);
		await this.sendResponse(state, id, { command: command.command, request: await this.inputs.cancel(requestId) });
	}

	private async completeFiles(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/complete requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const payload = objectPayload(command);
		if (payload.prefix !== undefined && typeof payload.prefix !== "string")
			throw new Error("filesystem/complete prefix must be a string");
		const prefix = payload.prefix === undefined ? "" : payload.prefix;
		const previous = this.completionControllers.get(command.sessionId);
		previous?.abort();
		const controller = new AbortController();
		this.completionControllers.set(command.sessionId, controller);
		try {
			await this.sendResponse(state, id, {
				command: command.command,
				...(command.requestId === undefined ? {} : { requestId: command.requestId }),
				items: await this.files.complete(command.sessionId, prefix, { signal: controller.signal }),
			});
		} finally {
			if (this.completionControllers.get(command.sessionId) === controller)
				this.completionControllers.delete(command.sessionId);
		}
	}

	private async resolveFile(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/reference/resolve requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			file: fileReferencePayload(
				await this.files.resolve(command.sessionId, referenceFrom(command, objectPayload(command))),
			),
		});
	}

	private async readFile(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/reference/read requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const result = await this.files.read(command.sessionId, referenceFrom(command, objectPayload(command)));
		await this.sendResponse(state, id, {
			command: command.command,
			file: fileReferencePayload(result.file),
			encoding: "base64",
			data: Buffer.from(result.data).toString("base64"),
		});
	}

	private async webRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("web requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const payload = objectPayload(command);
		const operation = payload.operation;
		const operations: readonly V2WebOperation[] = [
			"search_query",
			"open",
			"click",
			"find",
			"screenshot",
			"image_query",
			"finance",
			"weather",
			"sports",
			"time",
		];
		if (typeof operation !== "string" || !operations.includes(operation as V2WebOperation))
			throw new Error("web operation is invalid");
		const query = payload.query;
		const url = payload.url;
		const refId = payload.refId;
		const pattern = payload.pattern;
		const optionalString = (name: string): string | undefined => {
			const value = payload[name];
			if (value !== undefined && typeof value !== "string") throw new Error(`web ${name} must be a string`);
			return value;
		};
		const optionalPositiveInteger = (name: string): number | undefined => {
			const value = payload[name];
			if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1))
				throw new Error(`web ${name} must be a positive integer`);
			return value;
		};
		const ticker = optionalString("ticker");
		const market = optionalString("market");
		const location = optionalString("location");
		const duration = optionalPositiveInteger("duration");
		const start = optionalString("start");
		const dateFrom = optionalString("dateFrom");
		const dateTo = optionalString("dateTo");
		const league = optionalString("league");
		const team = optionalString("team");
		const opponent = optionalString("opponent");
		const numGames = optionalPositiveInteger("numGames");
		const locale = optionalString("locale");
		const utcOffset = optionalString("utcOffset");
		if (query !== undefined && typeof query !== "string") throw new Error("web query must be a string");
		if (url !== undefined && typeof url !== "string") throw new Error("web url must be a string");
		if (refId !== undefined && typeof refId !== "string") throw new Error("web refId must be a string");
		if (pattern !== undefined && typeof pattern !== "string") throw new Error("web pattern must be a string");
		const request = {
			operation: operation as V2WebOperation,
			...(query === undefined ? {} : { query }),
			...(url === undefined ? {} : { url }),
			...(refId === undefined ? {} : { refId }),
			...(pattern === undefined ? {} : { pattern }),
			...(ticker === undefined ? {} : { ticker }),
			...(market === undefined ? {} : { market }),
			...(location === undefined ? {} : { location }),
			...(duration === undefined ? {} : { duration }),
			...(start === undefined ? {} : { start }),
			...(dateFrom === undefined ? {} : { dateFrom }),
			...(dateTo === undefined ? {} : { dateTo }),
			...(league === undefined ? {} : { league }),
			...(team === undefined ? {} : { team }),
			...(opponent === undefined ? {} : { opponent }),
			...(numGames === undefined ? {} : { numGames }),
			...(locale === undefined ? {} : { locale }),
			...(utcOffset === undefined ? {} : { utcOffset }),
		};
		await this.sendResponse(state, id, {
			command: command.command,
			results: await this.web.execute(command.sessionId, request),
		});
	}

	private async viewImage(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("image/view requires sessionId");
		this.requireSessionReference(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.reference !== "string") throw new Error("image/view requires reference");
		await this.sendResponse(state, id, {
			command: command.command,
			image: await this.images.view(command.sessionId, payload.reference),
		});
	}

	private async generateImage(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("image/generate requires sessionId");
		this.requireControl(state, command.sessionId);
		const payload = objectPayload(command);
		if (typeof payload.prompt !== "string") throw new Error("image/generate requires prompt");
		if (payload.sourceDigest !== undefined && typeof payload.sourceDigest !== "string")
			throw new Error("image/generate sourceDigest must be a string");
		const image = await this.images.generate(command.sessionId, {
			prompt: payload.prompt,
			...(payload.sourceDigest === undefined ? {} : { sourceDigest: payload.sourceDigest }),
			sourceOperationId: id,
		});
		await this.usage.record({
			responseId: `${id}:image`,
			sessionId: command.sessionId,
			agentId: command.sessionId,
			operationId: id,
			purpose: "otherSideband",
			provider: image.provider,
			model: image.model,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			pricing: image.costUsd === undefined ? "unknown" : "providerReported",
			...(image.costUsd === undefined ? {} : { costUsd: image.costUsd }),
			imageUnits: 1,
			createdAt: Date.now(),
		});
		await this.sendResponse(state, id, {
			command: command.command,
			image,
		});
	}

	private async diagnosticsStatus(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (payload.sessionId !== undefined && typeof payload.sessionId !== "string")
			throw new Error("diagnostics/status sessionId must be a string");
		const sessionId = payload.sessionId === undefined ? undefined : payload.sessionId;
		const events = await this.diagnosticEvents();
		const scopedEvents = sessionId === undefined ? events : events.filter((event) => event.sessionId === sessionId);
		const critical = scopedEvents.filter((event) => event.severity === "error");
		await this.sendResponse(state, id, {
			command: command.command,
			capture: "metadata",
			degraded: critical.length > 0 || this.diagnostics.isDegraded?.() === true,
			lastCriticalEventSeq: critical.at(-1)?.seq ?? 0,
			eventCount: scopedEvents.length,
		});
	}

	private async diagnosticsTimeline(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (payload.sessionId !== undefined && typeof payload.sessionId !== "string")
			throw new Error("diagnostics/timeline sessionId must be a string");
		if (payload.operationId !== undefined && typeof payload.operationId !== "string")
			throw new Error("diagnostics/timeline operationId must be a string");
		const sessionId = payload.sessionId === undefined ? undefined : payload.sessionId;
		const operationId = payload.operationId === undefined ? undefined : payload.operationId;
		if (payload.afterSeq !== undefined && typeof payload.afterSeq !== "number")
			throw new Error("diagnostics/timeline afterSeq must be a number");
		if (typeof payload.afterSeq === "number" && (!Number.isSafeInteger(payload.afterSeq) || payload.afterSeq < 0))
			throw new Error("diagnostics/timeline afterSeq must be a non-negative safe integer");
		const events = await this.diagnosticEvents(typeof payload.afterSeq === "number" ? payload.afterSeq : 0);
		const [operationState, allUsageEntries] = await Promise.all([
			this.operationStore.load(),
			this.usage.read(sessionId === undefined ? {} : { sessionId }),
		]);
		const operations = operationState.operations.filter(
			(operation) =>
				(sessionId === undefined || operation.sessionId === sessionId) &&
				(operationId === undefined || operation.operationId === operationId),
		);
		const usageEntries =
			operationId === undefined
				? allUsageEntries
				: allUsageEntries.filter((entry) => entry.operationId === operationId);
		const usageAggregate =
			operationId === undefined
				? await this.usage.aggregate(sessionId === undefined ? {} : { sessionId })
				: aggregateV2UsageEntries(usageEntries);
		const operationEvents = operationState.events.filter(
			(event) =>
				(sessionId === undefined || event.sessionId === sessionId) &&
				(operationId === undefined || event.operationId === operationId),
		);
		await this.sendResponse(state, id, {
			command: command.command,
			events: events.filter(
				(event) =>
					(typeof payload.sessionId !== "string" || event.sessionId === payload.sessionId) &&
					(typeof payload.operationId !== "string" || event.operationId === payload.operationId),
			),
			operations: operations.map((operation) => toProtocolJsonValue(operation)),
			operationEvents: operationEvents.map((event) => toProtocolJsonValue(event)),
			usage: toProtocolJsonValue({ aggregate: usageAggregate, entries: usageEntries }),
			clockDiscontinuities: findDiagnosticClockDiscontinuities(events),
		});
	}

	private async diagnosticsExport(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (payload.sessionId !== undefined && typeof payload.sessionId !== "string")
			throw new Error("diagnostics/export sessionId must be a string");
		if (payload.operationId !== undefined && typeof payload.operationId !== "string")
			throw new Error("diagnostics/export operationId must be a string");
		if (payload.decryptContent !== undefined && typeof payload.decryptContent !== "boolean")
			throw new Error("diagnostics/export decryptContent must be a boolean");
		const sessionId = payload.sessionId === undefined ? undefined : payload.sessionId;
		const operationId = payload.operationId === undefined ? undefined : payload.operationId;
		await this.broadcastBundleProgress(sessionId, "started", 0, 1);
		const allEvents = await this.diagnosticEvents();
		const events = allEvents.filter(
			(event) =>
				(sessionId === undefined || event.sessionId === sessionId) &&
				(operationId === undefined || event.operationId === operationId),
		);
		const allCapsules = await this.diagnosticCapsulesForExport();
		const capsuleEventIds = new Set(
			events.flatMap((event) => {
				const contentRef = event.payload.contentRef;
				if (typeof contentRef !== "object" || contentRef === null || Array.isArray(contentRef)) return [];
				const eventId = (contentRef as Record<string, unknown>).eventId;
				return typeof eventId === "string" ? [eventId] : [];
			}),
		);
		const capsules =
			sessionId === undefined && operationId === undefined
				? allCapsules
				: allCapsules.filter((capsule) => capsuleEventIds.has(capsule.eventId));
		const integrity = this.integrity === undefined ? undefined : await this.integrity();
		const projections = await this.diagnosticProjections(sessionId, operationId);
		const decryptionRequested = payload.decryptContent === true;
		const decryptionUnavailable =
			decryptionRequested && this.diagnosticContent?.decrypt === undefined && capsules.length > 0;
		const decryptedCapsules =
			decryptionRequested && capsules.length > 0 && !decryptionUnavailable
				? await this.diagnosticCapsulesForDecryption(capsules)
				: undefined;
		const serializedEvents = JSON.stringify(events);
		const serializedCapsules = JSON.stringify(capsules);
		const serializedProjections = JSON.stringify(projections);
		const manifest = {
			schemaVersion: 1,
			eventCount: events.length,
			firstSeq: events[0]?.seq ?? 0,
			lastSeq: events.at(-1)?.seq ?? 0,
			eventsSha256: createHash("sha256").update(serializedEvents).digest("hex"),
			capsulesSha256: createHash("sha256").update(serializedCapsules).digest("hex"),
			projectionsSha256: createHash("sha256").update(serializedProjections).digest("hex"),
			...(sessionId === undefined && operationId === undefined
				? {}
				: {
						scope: {
							...(sessionId === undefined ? {} : { sessionId }),
							...(operationId === undefined ? {} : { operationId }),
						},
					}),
			...(state.clientDiagnostics === undefined || decryptionUnavailable
				? {
						unavailable: [
							...(state.clientDiagnostics === undefined ? ["client-diagnostic-spool"] : []),
							...(decryptionUnavailable ? ["diagnostic-content-decryption"] : []),
						],
					}
				: {}),
		};
		await this.sendResponse(state, id, {
			command: command.command,
			format: "json",
			events,
			capsules,
			bundle: {
				manifest,
				runtimeManifest: this.runtimeManifest,
				projections,
				...(integrity === undefined ? {} : { integrity }),
				...(state.clientDiagnostics === undefined ? {} : { clientDiagnostics: state.clientDiagnostics }),
				events,
				capsules,
				...(decryptedCapsules === undefined ? {} : { decryptedCapsules }),
			},
			...(decryptedCapsules === undefined ? {} : { decryptedCapsules }),
			...(integrity === undefined ? {} : { integrity }),
		});
		await this.broadcastBundleProgress(sessionId, "completed", 1, 1);
	}

	private async broadcastBundleProgress(
		sessionId: string | undefined,
		phase: "started" | "completed",
		completed: number,
		total: number,
	): Promise<void> {
		const runtimes = new Map<string, PiSessionRuntimeV2>();
		for (const connection of this.connections) {
			for (const [attachedSessionId, runtime] of connection.sessions) {
				if (sessionId === undefined || sessionId === attachedSessionId) runtimes.set(attachedSessionId, runtime);
			}
		}
		await Promise.all(
			Array.from(runtimes, ([attachedSessionId, runtime]) =>
				this.broadcastEvent(attachedSessionId, runtime, { phase, completed, total }, undefined, "bundle_progress"),
			),
		);
	}

	private async diagnosticProjections(
		sessionId: string | undefined,
		operationId: string | undefined,
	): Promise<DiagnosticBundleProjections> {
		const [allSessions, operationState, allUsageEntries, marketplaces, plugins, blobs] = await Promise.all([
			this.service.listSessions(),
			this.operationStore.load(),
			this.usage.read(sessionId === undefined ? {} : { sessionId }),
			this.plugins.listMarketplaces(),
			this.plugins.listPlugins(),
			this.blobs.list?.() ?? Promise.resolve([]),
		]);
		const sessions =
			sessionId === undefined ? allSessions : allSessions.filter((session) => session.id === sessionId);
		const sessionSnapshots: DiagnosticValue[] = [];
		if (sessionId !== undefined && sessions.length > 0) {
			const runtime = await this.service.openSession(sessionId);
			try {
				sessionSnapshots.push(toProtocolJsonValue(await runtime.snapshot()));
			} finally {
				await runtime.dispose();
			}
		}
		const operations = operationState.operations.filter(
			(operation) =>
				(sessionId === undefined || operation.sessionId === sessionId) &&
				(operationId === undefined || operation.operationId === operationId),
		);
		const operationEvents = operationState.events.filter(
			(event) =>
				(sessionId === undefined || event.sessionId === sessionId) &&
				(operationId === undefined || event.operationId === operationId),
		);
		const usageEntries =
			operationId === undefined
				? allUsageEntries
				: allUsageEntries.filter((entry) => entry.operationId === operationId);
		const usageAggregate =
			operationId === undefined
				? await this.usage.aggregate(sessionId === undefined ? {} : { sessionId })
				: aggregateV2UsageEntries(usageEntries);
		return {
			sessions: sessions.map((session) => toProtocolJsonValue(session)),
			...(sessionSnapshots.length === 0 ? {} : { sessionSnapshots }),
			operations: operations.map((operation) => toProtocolJsonValue(operation)),
			operationEvents: operationEvents.map((event) => toProtocolJsonValue(event)),
			usage: toProtocolJsonValue({ aggregate: usageAggregate, entries: usageEntries }),
			plugins: toProtocolJsonValue({ marketplaces, plugins }),
			blobs: blobs.map((blob) => toProtocolJsonValue(blob)),
		};
	}

	private async diagnosticsVerify(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const bundle = payload.bundle;
		if (bundle !== undefined && (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)))
			throw new Error("diagnostics/verify bundle must be an object");
		if (typeof bundle === "object" && bundle !== null && !Array.isArray(bundle)) {
			const verification = verifyDiagnosticBundle(bundle);
			if (verification.reason === "diagnostics/verify bundle requires events and manifest")
				throw new Error(verification.reason);
			await this.sendResponse(state, id, {
				command: command.command,
				...verification,
			});
			return;
		}
		const events = await this.diagnosticEvents();
		const gaps = events.slice(1).flatMap((event, index) => {
			const previous = events[index];
			return previous && event.seq !== previous.seq + 1 ? [{ from: previous.seq, to: event.seq }] : [];
		});
		await this.sendResponse(state, id, { command: command.command, valid: gaps.length === 0, gaps });
	}

	private async diagnosticsDoctor(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (payload.repairSafe !== undefined && typeof payload.repairSafe !== "boolean")
			throw new Error("diagnostics/doctor repairSafe must be a boolean");
		const events = await this.diagnosticEvents();
		const sequenceOk = events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1);
		let integrityChecks: readonly DiagnosticIntegrityCheck[] = [];
		if (this.integrity !== undefined) {
			try {
				integrityChecks = await this.integrity();
			} catch (error) {
				integrityChecks = [
					{
						name: "integrity",
						ok: false,
						details: { error: error instanceof Error ? error.name : "unknown" },
					},
				];
			}
		}
		const checks = [{ name: "recorder", ok: true }, { name: "sequence", ok: sequenceOk }, ...integrityChecks];
		let repairs: readonly DiagnosticRepairResult[] = [];
		if (payload.repairSafe === true && this.repairSafe !== undefined) {
			try {
				repairs = await this.repairSafe();
			} catch (error) {
				repairs = [
					{ name: "repair", ok: false, details: { error: error instanceof Error ? error.name : "unknown" } },
				];
			}
		}
		await this.sendResponse(state, id, {
			command: command.command,
			ok: checks.every((check) => check.ok),
			checks,
			...(payload.repairSafe === true ? { repairSafe: true, repairs } : {}),
		});
		await this.broadcastStoreIntegrityChanged(checks.every((check) => check.ok));
	}

	private async broadcastStoreIntegrityChanged(healthy: boolean): Promise<void> {
		if (this.lastEmittedStoreIntegrityHealthy === healthy) return;
		const runtimes = new Map<string, PiSessionRuntimeV2>();
		for (const connection of this.connections) {
			for (const [sessionId, runtime] of connection.sessions) runtimes.set(sessionId, runtime);
		}
		if (runtimes.size === 0) return;
		this.lastEmittedStoreIntegrityHealthy = healthy;
		await Promise.all(
			Array.from(runtimes, ([sessionId, runtime]) =>
				this.broadcastEvent(sessionId, runtime, { healthy }, undefined, "store_integrity_changed"),
			),
		);
	}

	private async addMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.name !== "string" || typeof payload.source !== "string")
			throw new Error("marketplace/add requires name and source");
		await this.sendResponse(state, id, {
			command: command.command,
			marketplace: await this.plugins.addMarketplace(payload.name, payload.source),
		});
	}

	private async listMarketplaces(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		await this.sendResponse(state, id, {
			command: command.command,
			marketplaces: await this.plugins.listMarketplaces(),
		});
	}

	private async upgradeMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.name !== "string") throw new Error("marketplace/upgrade requires name");
		await this.sendResponse(state, id, {
			command: command.command,
			marketplace: await this.plugins.upgradeMarketplace(payload.name),
		});
	}

	private async removeMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.name !== "string") throw new Error("marketplace/remove requires name");
		await this.plugins.removeMarketplace(payload.name);
		await this.sendResponse(state, id, { command: command.command, name: payload.name });
	}

	private async listPlugins(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (payload.installedOnly !== undefined && typeof payload.installedOnly !== "boolean")
			throw new Error("plugin/list installedOnly must be a boolean");
		await this.sendResponse(state, id, {
			command: command.command,
			plugins: await this.plugins.listPlugins(payload.installedOnly === true),
		});
	}

	private async readPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("plugin/read requires id");
		const plugin = await this.plugins.readPlugin(payload.id);
		if (!plugin) throw new Error(`Unknown plugin: ${payload.id}`);
		await this.sendResponse(state, id, { command: command.command, plugin });
	}

	private async installPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (
			typeof payload.name !== "string" ||
			typeof payload.marketplace !== "string" ||
			typeof payload.version !== "string" ||
			(payload.manifest !== undefined &&
				(typeof payload.manifest !== "object" || payload.manifest === null || Array.isArray(payload.manifest)))
		)
			throw new Error("plugin/install requires name, marketplace, and version");
		if (payload.root !== undefined && typeof payload.root !== "string")
			throw new Error("plugin/install root must be a string");
		if (payload.scope !== undefined && payload.scope !== "user" && payload.scope !== "project")
			throw new Error("plugin/install scope is invalid");
		await this.sendResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.installPlugin({
				name: payload.name,
				marketplace: payload.marketplace,
				version: payload.version,
				...(payload.manifest === undefined ? {} : { manifest: payload.manifest as Record<string, unknown> }),
				...(typeof payload.root === "string" ? { root: payload.root } : {}),
				...(payload.scope === "user" || payload.scope === "project" ? { scope: payload.scope } : {}),
			}),
		});
	}

	private async uninstallPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("plugin/uninstall requires id");
		await this.plugins.uninstallPlugin(payload.id);
		await this.sendResponse(state, id, { command: command.command, id: payload.id });
	}

	private async upgradePlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string" || typeof payload.version !== "string")
			throw new Error("plugin/upgrade requires id and version");
		if (
			payload.manifest !== undefined &&
			(typeof payload.manifest !== "object" || payload.manifest === null || Array.isArray(payload.manifest))
		)
			throw new Error("plugin/upgrade manifest must be an object");
		if (payload.root !== undefined && typeof payload.root !== "string")
			throw new Error("plugin/upgrade root must be a string");
		await this.sendResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.upgradePlugin(
				payload.id,
				payload.version,
				payload.manifest as Record<string, unknown> | undefined,
				typeof payload.root === "string" ? payload.root : undefined,
			),
		});
	}

	private async setPluginEnabled(
		state: V2ConnectionState,
		id: string,
		command: CommandV2,
		enabled: boolean,
	): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error(`${command.command} requires id`);
		if (payload.scope !== undefined && payload.scope !== "user" && payload.scope !== "project")
			throw new Error(`${command.command} scope is invalid`);
		await this.sendResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.setEnabled(
				payload.id,
				enabled,
				payload.scope === "user" || payload.scope === "project" ? payload.scope : undefined,
			),
		});
	}

	private async listApps(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const installed = (await this.plugins.listPlugins(true))
			.filter((plugin) => plugin.enabled)
			.flatMap((plugin) => plugin.appDescriptors ?? []);
		await this.sendResponse(state, id, {
			command: command.command,
			apps: [...(await this.apps.list()), ...installed],
		});
	}

	private async readApp(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/read requires id");
		const app =
			(await this.apps.read(payload.id)) ??
			((await this.plugins.listPlugins(true))
				.filter((plugin) => plugin.enabled)
				.flatMap((plugin) => plugin.appDescriptors ?? [])
				.find((candidate) => candidate.id === payload.id) as V2App | undefined);
		if (!app) throw new Error(`Unknown app: ${payload.id}`);
		await this.sendResponse(state, id, { command: command.command, app });
	}

	private async startAppAuth(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/auth/start requires id");
		const standalone = await this.apps.read(payload.id);
		if (!standalone && this.plugins.startAppAuth !== undefined) {
			const auth = await this.plugins.startAppAuth(payload.id, payload);
			await this.sendResponse(state, id, {
				command: command.command,
				auth,
			});
			await this.broadcastConnectorAuthChanged(auth);
			return;
		}
		const auth = await this.apps.startAuth(payload.id, payload);
		await this.sendResponse(state, id, {
			command: command.command,
			auth,
		});
		await this.broadcastConnectorAuthChanged(auth);
	}

	private async completeAppAuth(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/auth/complete requires id");
		const standalone = await this.apps.read(payload.id);
		if (!standalone && this.plugins.completeAppAuth !== undefined) {
			const auth = await this.plugins.completeAppAuth(payload.id, payload);
			await this.saveAppCredentials(payload.id, payload);
			await this.sendResponse(state, id, {
				command: command.command,
				auth,
			});
			await this.broadcastConnectorAuthChanged(auth);
			return;
		}
		const auth = await this.apps.completeAuth(payload.id, payload);
		await this.saveAppCredentials(payload.id, payload);
		await this.sendResponse(state, id, {
			command: command.command,
			auth,
		});
		await this.broadcastConnectorAuthChanged(auth);
	}

	private async broadcastConnectorAuthChanged(auth: V2AppAuthStart | V2AppAuthComplete): Promise<void> {
		const runtimes = new Map<string, PiSessionRuntimeV2>();
		for (const connection of this.connections) {
			for (const [sessionId, runtime] of connection.sessions) runtimes.set(sessionId, runtime);
		}
		await Promise.all(
			Array.from(runtimes, ([sessionId, runtime]) =>
				this.broadcastEvent(
					sessionId,
					runtime,
					{ appId: auth.appId, state: auth.state },
					undefined,
					"connector_auth_changed",
				),
			),
		);
	}

	private async saveAppCredentials(appId: string, payload: Record<string, unknown>): Promise<void> {
		const credentials = payload.credentials;
		if (credentials !== null && typeof credentials === "object" && !Array.isArray(credentials))
			await this.appCredentials.save(appId, credentials as Record<string, unknown>);
	}

	private async readUsage(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const filter: V2UsageFilter = {};
		for (const key of ["sessionId", "agentId", "turnId", "goalId", "provider", "model"] as const) {
			if (payload[key] !== undefined && typeof payload[key] !== "string")
				throw new Error(`usage/read ${key} must be a string`);
			if (typeof payload[key] === "string") (filter as { [name: string]: string })[key] = payload[key];
		}
		if (
			payload.purpose !== undefined &&
			!["agent", "compaction", "sessionName", "otherSideband"].includes(String(payload.purpose))
		)
			throw new Error("usage/read purpose is invalid");
		if (typeof payload.purpose === "string")
			(filter as { purpose: V2UsageFilter["purpose"] }).purpose = payload.purpose as V2UsageFilter["purpose"];
		await this.sendResponse(state, id, {
			command: command.command,
			aggregate: await this.usage.aggregate(filter),
			entries: await this.usage.read(filter),
		});
	}

	private async diagnosticEvents(afterSeq = 0): Promise<Awaited<ReturnType<ForensicRecorder["read"]>>> {
		return this.diagnostics.read(afterSeq);
	}

	private async detach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/detach requires sessionId");
		state.sessions.delete(command.sessionId);
		this.releaseControlFor(state, command.sessionId);
		await this.sendResponse(state, id, { command: command.command, sessionId: command.sessionId });
	}

	private async startTurn(
		state: V2ConnectionState,
		id: string,
		command: CommandV2,
		onAccepted?: () => void,
	): Promise<void> {
		if (!command.sessionId) throw new Error("turn/start requires sessionId");
		const sessionId = command.sessionId;
		this.requireControl(state, sessionId);
		const runtime = state.sessions.get(sessionId);
		if (!runtime) throw new Error(`Session ${sessionId} is not attached`);
		const payload = objectPayload(command);
		validateGoalCommand(command, payload);
		validateTurnCommand(command, payload);
		validateSessionLabelCommand(command, payload);
		const resolvedCommand = await this.resolveTurnContent(command);
		const operationId = randomUUID();
		const capsule = this.diagnosticContent
			? await this.diagnosticContent.encrypt({
					eventId: operationId,
					kind: command.command,
					content: JSON.stringify(resolvedCommand.payload ?? {}),
				})
			: undefined;
		if (capsule !== undefined) {
			await this.diagnosticContent?.save?.(capsule);
			this.diagnosticCapsules.set(capsule.eventId, capsule);
		}
		let accepted: OperationAccepted;
		try {
			accepted = await runtime.accept(operationId, resolvedCommand);
			this.operations.set(operationId, {
				operationId,
				sessionId: command.sessionId,
				state: "accepted",
				accepted,
			});
			const acceptedRecord = this.operations.get(operationId)!;
			await this.operationStore.putOperation(acceptedRecord);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.operations.delete(operationId);
			await runtime.rejectAccepted?.(operationId, message).catch(() => undefined);
			await this.recordProtocolDiagnostic({
				kind: "operation_accept_failed",
				severity: "error",
				outcome: "error",
				traceId: operationId,
				spanId: id,
				sessionId: command.sessionId,
				operationId,
				payload: { error: message },
			});
			throw error;
		}
		const acceptedRecord = this.operations.get(operationId)!;
		try {
			await this.diagnostics?.record({
				kind: "operation_accepted",
				severity: "info",
				outcome: "started",
				traceId: operationId,
				spanId: id,
				sessionId: command.sessionId,
				operationId,
				payload: {
					command: command.command,
					...(capsule === undefined
						? {}
						: {
								contentRef: {
									eventId: capsule.eventId,
									kind: capsule.kind,
									keyId: capsule.keyId,
									plaintextSha256: capsule.plaintextSha256,
									byteLength: capsule.byteLength,
									originalByteLength: capsule.originalByteLength,
									truncated: capsule.truncated,
								},
							}),
				},
			});
		} catch (error) {
			const failed = {
				...acceptedRecord,
				state: "failed" as const,
				error: "Critical diagnostic persistence failed",
			};
			this.operations.set(operationId, failed);
			await this.operationStore.putOperation(failed).catch(() => undefined);
			throw error;
		}
		await this.send(state, { type: "response", id, ok: true, accepted });
		await this.broadcastEvent(
			command.sessionId,
			runtime,
			{ state: "accepted", accepted },
			operationId,
			"operation_accepted",
			{ eventSeq: accepted.eventSeq, revision: accepted.sessionRevision },
		);
		onAccepted?.();
		const execute = () => this.runOperation(runtime, sessionId, operationId, resolvedCommand);
		if (command.command === "turn/abort" || command.command === "turn/steer" || command.command === "turn/followUp")
			void execute();
		else await execute();
	}

	private runSessionCommand(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const interactive =
			command.command === "turn/abort" || command.command === "turn/steer" || command.command === "turn/followUp";
		if (interactive || command.sessionId === undefined) return this.startTurn(state, id, command);
		let resolveAcknowledged: (() => void) | undefined;
		let rejectAcknowledged: ((error: unknown) => void) | undefined;
		const acknowledged = new Promise<void>((resolve, reject) => {
			resolveAcknowledged = resolve;
			rejectAcknowledged = reject;
		});
		void this.enqueueSessionOperation(command.sessionId, () =>
			this.startTurn(state, id, command, () => resolveAcknowledged?.()),
		).catch((error: unknown) => rejectAcknowledged?.(error));
		return acknowledged;
	}

	private enqueueSessionOperation(sessionId: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.sessionOperationTails.get(sessionId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.sessionOperationTails.set(sessionId, next);
		void next.then(
			() => {
				if (this.sessionOperationTails.get(sessionId) === next) this.sessionOperationTails.delete(sessionId);
			},
			() => {
				if (this.sessionOperationTails.get(sessionId) === next) this.sessionOperationTails.delete(sessionId);
			},
		);
		return next;
	}

	private async diagnosticCapsulesForExport(): Promise<readonly DiagnosticCapsule[]> {
		const persisted = await this.diagnosticContent?.list?.();
		return persisted === undefined ? [...this.diagnosticCapsules.values()] : persisted;
	}

	private async diagnosticCapsulesForDecryption(capsules: readonly DiagnosticCapsule[]): Promise<readonly object[]> {
		if (this.diagnosticContent?.decrypt === undefined)
			throw new Error("diagnostics/export --decrypt-content is unavailable for this diagnostic store");
		return Promise.all(
			capsules.map(async (capsule) => ({
				eventId: capsule.eventId,
				kind: capsule.kind,
				content: Buffer.from(await this.diagnosticContent!.decrypt!(capsule)).toString("base64"),
				byteLength: capsule.byteLength,
			})),
		);
	}

	private async resolveTurnContent(command: CommandV2): Promise<CommandV2> {
		const payload = objectPayload(command);
		if (!Array.isArray(payload.content)) return command;
		const content = await Promise.all(
			payload.content.map(async (part, index) => {
				if (typeof part !== "object" || part === null || Array.isArray(part))
					throw new Error(`turn content item ${index} must be an object`);
				const item = part as Record<string, unknown>;
				if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
				if (item.type === "mention") {
					if (typeof command.sessionId !== "string") throw new Error("turn mention requires sessionId");
					return this.resolveMention(command.sessionId, item, index);
				}
				if (item.type !== "image" && item.type !== "blob")
					throw new Error(`turn content item ${index} must be text, image, or blob`);
				if (typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/"))
					throw new Error(`turn content item ${index} requires an image MIME type`);
				if (typeof item.data === "string") return { type: "image", data: item.data, mimeType: item.mimeType };
				if (typeof item.digest !== "string") throw new Error(`turn content item ${index} requires a blob digest`);
				const blob = await this.blobs.stat(item.digest);
				if (blob.mimeType !== item.mimeType)
					throw new Error(`turn content item ${index} MIME type does not match blob metadata`);
				const data = await this.blobs.read(item.digest);
				return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: item.mimeType };
			}),
		);
		return { ...command, payload: toProtocolJsonValue({ ...payload, content }) };
	}

	private async resolveMention(
		sessionId: string,
		item: Record<string, unknown>,
		index: number,
	): Promise<{ type: "text"; text: string }> {
		if (typeof item.name !== "string" || typeof item.path !== "string")
			throw new Error(`turn content item ${index} mention requires name and path`);
		const name = item.name.trim();
		const path = item.path.trim();
		const referencePath = path.startsWith("@") ? path.slice(1) : path;
		if (name.length === 0 || path.length === 0) throw new Error(`turn content item ${index} mention is empty`);
		if (path.startsWith("app://")) {
			const appId = path.slice("app://".length);
			const app =
				(await this.apps.read(appId)) ??
				(await this.plugins.listPlugins(true))
					.filter((plugin) => plugin.enabled)
					.flatMap((plugin) => plugin.appDescriptors ?? [])
					.find((candidate) => candidate.id === appId);
			if (!app?.enabled) throw new Error(`Unknown or disabled app mention: ${path}`);
		} else if (path.startsWith("plugin://")) {
			const plugin = await this.plugins.readPlugin(path.slice("plugin://".length));
			if (!plugin?.enabled) throw new Error(`Unknown or disabled plugin mention: ${path}`);
		} else {
			if (referencePath.startsWith("local:")) {
				if (typeof item.blobDigest !== "string" || typeof item.mimeType !== "string")
					throw new Error(`Local mention requires blobDigest and mimeType: ${path}`);
				const blob = await this.blobs.stat(item.blobDigest);
				if (blob.mimeType !== item.mimeType)
					throw new Error(`Local mention MIME type does not match blob metadata: ${path}`);
			} else {
				await this.files.resolve(sessionId, referencePath);
			}
			return { type: "text", text: `@${name} ${path}` };
		}
		return { type: "text", text: `@${name}` };
	}

	private async runOperation(
		runtime: PiSessionRuntimeV2,
		sessionId: string,
		operationId: string,
		command: CommandV2,
	): Promise<void> {
		const beforeSnapshot = await runtime.snapshot();
		const abortedOperationId =
			command.command === "turn/abort"
				? [...this.operations.values()].find(
						(record) =>
							record.sessionId === sessionId &&
							record.operationId !== operationId &&
							(record.state === "accepted" || record.state === "running"),
					)?.operationId
				: undefined;
		try {
			const acceptedRecord = this.operations.get(operationId);
			if (acceptedRecord?.state === "accepted") {
				const runningRecord = { ...acceptedRecord, state: "running" as const };
				this.operations.set(operationId, runningRecord);
				await this.operationStore.putOperation(runningRecord);
				await this.broadcastEvent(sessionId, runtime, { state: "running" }, operationId, "operation_updated");
				if (
					command.command === "turn/start" ||
					command.command === "turn/steer" ||
					command.command === "turn/followUp" ||
					command.command === "turn/resume"
				)
					await this.broadcastEvent(sessionId, runtime, { command: command.command }, operationId, "turn_started");
				if (command.command === "turn/compact")
					await this.broadcastEvent(sessionId, runtime, {}, operationId, "compaction_started");
			}
			if (abortedOperationId !== undefined) {
				const target = this.operations.get(abortedOperationId);
				if (target !== undefined && (target.state === "accepted" || target.state === "running")) {
					const aborted = { ...target, state: "aborted" as const };
					this.operations.set(abortedOperationId, aborted);
					await this.operationStore.putOperation(aborted);
				}
			}
			await runtime.run(operationId, command);
			if (command.command === "turn/compact")
				await this.broadcastEvent(sessionId, runtime, {}, operationId, "compaction_completed");
			const completedSnapshot = await runtime.snapshot();
			await this.broadcastSnapshotChanges(sessionId, runtime, operationId, beforeSnapshot, completedSnapshot);
			const record = this.operations.get(operationId);
			if (record?.state === "aborted") return;
			if (record) {
				const updated = { ...record, state: "complete" as const };
				this.operations.set(operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.broadcastEvent(
				sessionId,
				runtime,
				{ state: "complete", snapshot: toProtocolJsonValue(await runtime.snapshot()) },
				operationId,
				"operation_terminal",
			);
			if (abortedOperationId !== undefined) {
				const target = this.operations.get(abortedOperationId);
				if (target?.state === "aborted") {
					const terminalSeq = (await runtime.snapshot()).eventSeq;
					const terminal = { ...target, terminalSeq };
					this.operations.set(abortedOperationId, terminal);
					await this.operationStore.putOperation(terminal);
					await this.broadcastEvent(
						sessionId,
						runtime,
						{ state: "aborted", snapshot: toProtocolJsonValue(await runtime.snapshot()) },
						abortedOperationId,
						"operation_terminal",
					);
				}
			}
			const completed = this.operations.get(operationId);
			if (completed) {
				const updated = { ...completed, terminalSeq: (await runtime.snapshot()).eventSeq };
				this.operations.set(operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.diagnostics?.record({
				kind: "operation_terminal",
				severity: "info",
				outcome: "ok",
				traceId: operationId,
				spanId: operationId,
				sessionId,
				operationId,
				payload: { state: "complete" },
			});
		} catch (error) {
			await this.broadcastSnapshotChanges(sessionId, runtime, operationId, beforeSnapshot, await runtime.snapshot());
			const message = error instanceof Error ? error.message : String(error);
			const failureSnapshot = await runtime.snapshot();
			const record = this.operations.get(operationId);
			if (record?.state === "complete") return;
			if (record) {
				const updated = { ...record, state: "failed" as const, error: message };
				this.operations.set(operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.broadcastEvent(
				sessionId,
				runtime,
				{ state: "failed", error: message, snapshot: toProtocolJsonValue(failureSnapshot) },
				operationId,
				"operation_terminal",
			);
			const failed = this.operations.get(operationId);
			if (failed) {
				const updated = { ...failed, terminalSeq: failureSnapshot.eventSeq };
				this.operations.set(failed.operationId, updated);
				await this.operationStore.putOperation(updated);
			}
			await this.diagnostics?.record({
				kind: "operation_terminal",
				severity: "error",
				outcome: "error",
				traceId: operationId,
				spanId: operationId,
				sessionId,
				operationId,
				payload: { state: "failed", error: message },
			});
		}
	}

	private async broadcastSnapshotChanges(
		sessionId: string,
		runtime: PiSessionRuntimeV2,
		operationId: string,
		before: Awaited<ReturnType<PiSessionRuntimeV2["snapshot"]>>,
		after: Awaited<ReturnType<PiSessionRuntimeV2["snapshot"]>>,
	): Promise<void> {
		if (
			before.nameRevision !== after.nameRevision ||
			before.name !== after.name ||
			before.nameSource !== after.nameSource
		)
			await this.broadcastEvent(
				sessionId,
				runtime,
				{
					name: after.name ?? null,
					nameSource: after.nameSource ?? null,
					nameRevision: after.nameRevision,
				},
				operationId,
				"session_name_updated",
			);
		if (before.phase !== after.phase)
			await this.broadcastEvent(sessionId, runtime, { phase: after.phase }, operationId, "session_phase_changed");
		if (
			before.usage.input !== after.usage.input ||
			before.usage.output !== after.usage.output ||
			before.usage.cacheRead !== after.usage.cacheRead ||
			before.usage.cacheWrite !== after.usage.cacheWrite ||
			before.usage.imageUnits !== after.usage.imageUnits ||
			before.usage.costUsd !== after.usage.costUsd ||
			before.usage.pricingState !== after.usage.pricingState
		)
			await this.broadcastEvent(sessionId, runtime, { usage: after.usage }, operationId, "usage_updated");
		if (JSON.stringify(before.goal) !== JSON.stringify(after.goal))
			await this.broadcastEvent(sessionId, runtime, { goal: after.goal ?? null }, operationId, "goal_updated");
		if (JSON.stringify(before.compactionPolicy) !== JSON.stringify(after.compactionPolicy))
			await this.broadcastEvent(
				sessionId,
				runtime,
				{ compactionPolicy: after.compactionPolicy },
				operationId,
				"model_compaction_policy_changed",
			);
		if (JSON.stringify(before.instructionProfile) !== JSON.stringify(after.instructionProfile))
			await this.broadcastEvent(
				sessionId,
				runtime,
				{ instructionProfile: after.instructionProfile ?? null },
				operationId,
				"model_instruction_profile_changed",
			);
		const delta: Record<string, unknown> = {};
		if (before.name !== after.name) delta.name = after.name ?? null;
		if (before.nameSource !== after.nameSource) delta.nameSource = after.nameSource ?? null;
		if (before.nameRevision !== after.nameRevision) delta.nameRevision = after.nameRevision;
		if (before.phase !== after.phase) delta.phase = after.phase;
		if (JSON.stringify(before.usage) !== JSON.stringify(after.usage)) delta.usage = after.usage;
		if (JSON.stringify(before.goal) !== JSON.stringify(after.goal)) delta.goal = after.goal ?? null;
		if (JSON.stringify(before.compactionPolicy) !== JSON.stringify(after.compactionPolicy))
			delta.compactionPolicy = after.compactionPolicy;
		if (JSON.stringify(before.instructionProfile) !== JSON.stringify(after.instructionProfile))
			delta.instructionProfile = after.instructionProfile ?? null;
		if (Object.keys(delta).length > 0)
			await this.broadcastEvent(sessionId, runtime, { delta }, operationId, "session_delta");
	}

	private async readOperation(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.operationId) throw new Error("operation/read requires operationId");
		const operation = this.operations.get(command.operationId);
		if (!operation) throw new Error(`Unknown operation ${command.operationId}`);
		this.requireSessionReference(state, operation.sessionId);
		await this.sendResponse(state, id, { command: command.command, operation });
	}

	private async broadcastEvent(
		sessionId: string,
		runtime: PiSessionRuntimeV2,
		payload: Record<string, unknown>,
		operationId: string | undefined,
		eventName: EventEnvelopeV2["event"],
		sequence?: { eventSeq: number; revision: number },
	): Promise<void> {
		const snapshot = await runtime.snapshot();
		const history = this.eventHistory.get(sessionId) ?? [];
		const lastEvent = history.at(-1);
		const event: ServerMessageV2 = {
			type: "event",
			sessionId,
			seq: sequence?.eventSeq ?? Math.max(snapshot.eventSeq, lastEvent?.seq ?? 0) + 1,
			revision: sequence?.revision ?? Math.max(snapshot.revision, lastEvent?.revision ?? 0) + 1,
			...(operationId === undefined ? {} : { operationId }),
			event: eventName,
			payload: toProtocolJsonValue(payload),
		};
		history.push(event);
		if (history.length > MAX_EVENT_HISTORY) history.splice(0, history.length - MAX_EVENT_HISTORY);
		this.eventHistory.set(sessionId, history);
		await this.operationStore.appendEvent(event);
		await Promise.allSettled(
			Array.from(this.connections)
				.filter((connection) => connection.sessions.get(sessionId) === runtime)
				.map((connection) => this.sendEvent(connection, event)),
		);
	}

	private async sendResponse(state: V2ConnectionState, id: string, result: Record<string, unknown>): Promise<void> {
		await this.recordCommandOutcome(state, id, "ok");
		await this.send(state, { type: "response", id, ok: true, result: toProtocolJsonValue(result) });
	}

	private async sendError(state: V2ConnectionState, id: string, code: string, message: string): Promise<void> {
		await this.recordCommandOutcome(state, id, "error", { code, message });
		if (state.closed) return;
		try {
			await this.send(state, { type: "response", id, ok: false, error: { code, message } });
		} catch {
			// The request may finish after the client has disconnected; no response can be delivered.
			this.disconnect(state);
		}
	}

	private async recordCommandOutcome(
		state: V2ConnectionState,
		id: string,
		outcome: "ok" | "error",
		error?: { code: string; message: string },
	): Promise<void> {
		const key = `${state.id}:${id}`;
		const command = this.pendingRequests.get(key);
		if (command === undefined) return;
		this.pendingRequests.delete(key);
		await this.recordProtocolDiagnostic({
			kind: "protocol_command_completed",
			severity: outcome === "ok" ? "debug" : "error",
			outcome,
			traceId: command.operationId ?? command.requestId ?? id,
			spanId: id,
			...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
			...(command.operationId === undefined ? {} : { operationId: command.operationId }),
			...(this.daemonInstanceId === undefined ? {} : { daemonInstanceId: this.daemonInstanceId }),
			payload: {
				command: command.command,
				requestId: id,
				...(error === undefined ? {} : { errorCode: error.code, error: error.message }),
			},
		});
	}

	private async recordProtocolDiagnostic(event: Parameters<ForensicRecorder["record"]>[0]): Promise<void> {
		try {
			await this.diagnostics.record(event);
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private send(state: V2ConnectionState, message: ServerMessageV2): Promise<void> {
		return state.connection.send(encodeServerMessageV2(message));
	}

	private sendEvent(state: V2ConnectionState, event: ServerMessageV2): Promise<void> {
		const previous = this.eventDeliveryTails.get(state) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.send(state, event));
		this.eventDeliveryTails.set(state, next);
		return next;
	}

	private async failProtocol(state: V2ConnectionState, code: string, message: string): Promise<void> {
		if (state.closed) return;
		await state.connection.close(encodeServerMessageV2({ type: "hello_error", error: { code, message } }));
		this.disconnect(state);
	}

	private async closeConnection(state: V2ConnectionState): Promise<void> {
		if (state.closed) return;
		state.closed = true;
		clearTimeout(state.handshakeTimeout);
		for (const sessionId of state.controlSessions) this.releaseControlFor(state, sessionId);
		await Promise.allSettled(Array.from(state.sessions.values(), (runtime) => this.disposeRuntime(runtime)));
		await state.connection.close();
		this.connections.delete(state);
	}

	private disconnect(state: V2ConnectionState): void {
		if (state.closed) return;
		state.closed = true;
		clearTimeout(state.handshakeTimeout);
		for (const sessionId of state.controlSessions) this.releaseControlFor(state, sessionId);
		this.connections.delete(state);
	}

	private claimControl(state: V2ConnectionState, sessionId: string): void {
		const owner = this.controls.get(sessionId);
		if (owner !== undefined && owner !== state.id)
			throw new Error(`Session ${sessionId} already has a control lease`);
		this.controls.set(sessionId, state.id);
		state.controlSessions.add(sessionId);
	}

	private requireControl(state: V2ConnectionState, sessionId: string): void {
		if (this.controls.get(sessionId) === state.id) return;
		if (this.controls.get(sessionId) === undefined && !state.sessions.has(sessionId)) {
			this.claimControl(state, sessionId);
			return;
		}
		throw new Error(`Session ${sessionId} requires a control lease`);
	}

	private requireProcessSession(state: V2ConnectionState, command: CommandV2, sessionId: string): void {
		if (command.sessionId === undefined) throw new Error(`${command.command} requires sessionId`);
		if (command.sessionId !== sessionId)
			throw new Error(`${command.command} sessionId does not match process session`);
		if (!state.sessions.has(sessionId) && this.controls.get(sessionId) !== state.id)
			throw new Error(`Session ${sessionId} is not attached`);
	}

	private requireSessionReference(state: V2ConnectionState, sessionId: string): void {
		if (!state.sessions.has(sessionId) && this.controls.get(sessionId) !== state.id)
			throw new Error(`Session ${sessionId} is not attached`);
	}

	private releaseControlFor(state: V2ConnectionState, sessionId: string): void {
		if (this.controls.get(sessionId) === state.id) this.controls.delete(sessionId);
		state.controlSessions.delete(sessionId);
	}

	private hasRuntimeReference(runtime: PiSessionRuntimeV2): boolean {
		return Array.from(this.connections).some((connection) =>
			Array.from(connection.sessions.values()).some((candidate) => candidate === runtime),
		);
	}

	private trackRuntime(runtime: PiSessionRuntimeV2): void {
		this.runtimes.add(runtime);
		if (runtime.onEvent !== undefined && !this.runtimeEventUnsubscribers.has(runtime)) {
			const unsubscribe = runtime.onEvent((event) => {
				void this.broadcastEvent(event.sessionId, runtime, event.payload, event.operationId, event.event).catch(
					(error) => this.reportError(error instanceof Error ? error : new Error(String(error))),
				);
			});
			this.runtimeEventUnsubscribers.set(runtime, unsubscribe);
		}
	}

	private async disposeRuntime(runtime: PiSessionRuntimeV2): Promise<void> {
		if (this.disposedRuntimes.has(runtime)) return;
		this.disposedRuntimes.add(runtime);
		const unsubscribe = this.runtimeEventUnsubscribers.get(runtime);
		this.runtimeEventUnsubscribers.delete(runtime);
		try {
			await runtime.dispose();
		} finally {
			unsubscribe?.();
		}
	}

	private reportError(error: Error): void {
		this.onError?.(error);
	}

	private notifyDiagnosticsDegraded(event: Parameters<ForensicRecorder["record"]>[0]): void {
		if (this.diagnosticsDegradedNotified || this.diagnostics.isDegraded?.() !== true) return;
		const sessions = new Map<string, PiSessionRuntimeV2>();
		for (const connection of this.connections) {
			for (const [sessionId, runtime] of connection.sessions) {
				if (event.sessionId === undefined || event.sessionId === sessionId) sessions.set(sessionId, runtime);
			}
		}
		if (sessions.size === 0) return;
		this.diagnosticsDegradedNotified = true;
		for (const [sessionId, runtime] of sessions) {
			void this.broadcastEvent(
				sessionId,
				runtime,
				{ degraded: true },
				event.operationId,
				"diagnostics_degraded",
			).catch((error) => this.reportError(error instanceof Error ? error : new Error(String(error))));
		}
	}
}
