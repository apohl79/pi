import { randomUUID } from "node:crypto";
import {
	type ClientHelloV2,
	type CommandV2,
	decodeCbor,
	type EventEnvelopeV2,
	encodeServerMessageV2,
	FrameDecoder,
	type ModelMetadata,
	type OperationAccepted,
	type OperationRecordV2,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
	type SessionMetadataV2,
	type SessionSnapshotV2,
	MAX_V2_ARRAY_ITEMS,
	MAX_V2_STRING_LENGTH,
} from "@earendil-works/pi-protocol";
import { InMemoryV2AgentRegistry, type V2AgentRegistry } from "./agents.ts";
import { InMemoryV2AppRegistry, type V2AppRegistry } from "./apps.ts";
import { InMemoryV2BlobStore, type V2BlobStore } from "./blobs.ts";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import { type ForensicRecorder, InMemoryForensicRecorder } from "./diagnostics.ts";
import { LocalV2FileReferenceService, type V2FileReferenceService } from "./files.ts";
import { InMemoryV2InputRegistry, type V2InputRegistry } from "./inputs.ts";
import type { PiServerListener } from "./listener.ts";
import { InMemoryV2OperationStore, type V2OperationStore } from "./operation-store.ts";
import { InMemoryV2PlanRegistry, type V2PlanRegistry } from "./plans.ts";
import { InMemoryV2PluginRegistry, type V2PluginRegistry } from "./plugins.ts";
import { InMemoryV2ProcessRegistry, type V2ProcessRegistry } from "./processes.ts";
import { toProtocolJsonValue } from "./protocol.ts";
import type { MaybePromise } from "./types.ts";

export interface PiSessionRuntimeV2 {
	snapshot(): MaybePromise<SessionSnapshotV2>;
	accept(operationId: string): Promise<OperationAccepted>;
	run(operationId: string, command: CommandV2): Promise<void>;
	dispose(): Promise<void>;
}

export interface PiServerServiceV2 {
	listSessions(): Promise<SessionMetadataV2[]>;
	listModels(): Promise<ModelMetadata[]>;
	openSession(sessionId: string): Promise<PiSessionRuntimeV2>;
	createSession?(options: Record<string, unknown>): Promise<{ sessionId: string; runtime: PiSessionRuntimeV2 }>;
	deleteSession?(sessionId: string): Promise<void>;
}

export interface PiServerV2Options {
	listeners: readonly PiServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
	diagnostics?: ForensicRecorder;
	operationStore?: V2OperationStore;
	processes?: V2ProcessRegistry;
	blobs?: V2BlobStore;
	agents?: V2AgentRegistry;
	apps?: V2AppRegistry;
	plans?: V2PlanRegistry;
	inputs?: V2InputRegistry;
	files?: V2FileReferenceService;
	plugins?: V2PluginRegistry;
}

type V2ConnectionState = {
	id: string;
	connection: ByteConnection;
	decoder: FrameDecoder;
	sessions: Map<string, PiSessionRuntimeV2>;
	controlSessions: Set<string>;
	/** Session IDs whose attach response has committed the connection's ownership. */
	attachedSessions: Set<string>;
	/** Number of in-flight attach requests for each session on this connection. */
	pendingAttachCounts: Map<string, number>;
	visibleSessions: Set<string>;
	ready: boolean;
	handshakePromise?: Promise<void>;
	closed: boolean;
	attachingSessions: Map<string, Promise<PiSessionRuntimeV2>>;
	disconnectPromise?: Promise<void>;
	handshakeTimeout: NodeJS.Timeout;
};

const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;
const MAX_UINT32 = 0xffff_ffff;
const MAX_AGENT_MESSAGE_EVENT_LENGTH = 4096;

function validateBoundedOption(name: string, value: number | undefined, fallback: number, maximum: number): number {
	const candidate = value ?? fallback;
	if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) throw new Error(`${name} must be a positive safe integer no larger than ${maximum}`);
	return candidate;
}

function objectPayload(command: CommandV2): Record<string, unknown> {
	if (typeof command.payload !== "object" || command.payload === null || Array.isArray(command.payload)) return {};
	return command.payload as Record<string, unknown>;
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
	const requestId = payload.requestId ?? command.operationId;
	if (typeof requestId !== "string" || requestId.length === 0) throw new Error("requestId is required");
	return requestId;
}

function safeOperationError(error: unknown): string {
	if (!(error instanceof Error) || error.message.length === 0 || error.message.length > 500) return "Operation failed";
	const message = error.message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	if (/bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|\b(?:sk|pk|rk)-[a-z0-9_-]{8,}/i.test(message))
		return "Operation failed";
	return message || "Operation failed";
}

function safeDiagnosticMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const message = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	if (
		message.length === 0 ||
		message.length > 500 ||
		/\bbearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|\b(?:sk|pk|rk)-[a-z0-9_-]{8,}/i.test(
			message,
		)
	)
		return "Server error";
	return message;
}

function safeAgentMessage(message: string): string {
	const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	const redacted = normalized
		.replace(/bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[redacted]")
		.replace(/\b(?:sk|pk|rk)-[a-z0-9_-]{8,}/gi, "[redacted]");
	return redacted.length > MAX_AGENT_MESSAGE_EVENT_LENGTH
		? `${redacted.slice(0, MAX_AGENT_MESSAGE_EVENT_LENGTH - 1)}…`
		: redacted;
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
	private readonly diagnostics: ForensicRecorder;
	private readonly operationStore: V2OperationStore;
	private readonly processes: V2ProcessRegistry;
	private readonly blobs: V2BlobStore;
	private readonly agents: V2AgentRegistry;
	private readonly apps: V2AppRegistry;
	private readonly plans: V2PlanRegistry;
	private readonly inputs: V2InputRegistry;
	private readonly files: V2FileReferenceService;
	private readonly plugins: V2PluginRegistry;
	private readonly ownsAgents: boolean;
	private readonly connections = new Set<V2ConnectionState>();
	private readonly controls = new Map<string, string>();
	private readonly runtimes = new Set<PiSessionRuntimeV2>();
	private readonly eventHistory = new Map<string, EventEnvelopeV2[]>();
	/** Serializes event reservation per session so concurrent broadcasts cannot reuse cursors. */
	private readonly broadcastTails = new Map<string, Promise<void>>();
	private readonly agentWatches = new Map<string, { rerun: boolean }>();
	private readonly operations = new Map<string, OperationRecordV2>();
	private readonly processSessions = new Map<string, string>();
	private readonly agentSessions = new Map<string, string>();
	private readonly inputSessions = new Map<string, string>();
	private readonly disposedRuntimes = new WeakSet<PiSessionRuntimeV2>();
	private readonly activeOperations = new Map<PiSessionRuntimeV2, number>();
	private readonly activeOperationSessions = new Map<string, number>();
	private readonly deletingSessions = new Set<string>();
	private readonly deletedSessions = new Set<string>();
	/** Pending attach leases must protect the runtime instance they resolve to. */
	private readonly pendingAttaches = new WeakMap<PiSessionRuntimeV2, number>();
	private startPromise?: Promise<this>;
	private closePromise?: Promise<void>;
	private closing = false;
	private started = false;
	private restored = false;

	constructor(service: PiServerServiceV2, options: PiServerV2Options) {
		this.service = service;
		this.listeners = options.listeners;
		this.id = options.serverId ?? randomUUID();
		this.maxFrameLength = validateBoundedOption("maxFrameLength", options.maxFrameLength, DEFAULT_MAX_FRAME_LENGTH, MAX_UINT32);
		this.handshakeTimeoutMs = validateBoundedOption("handshakeTimeoutMs", options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 2_147_483_647);
		this.onError = options.onError;
		this.diagnostics = options.diagnostics ?? new InMemoryForensicRecorder();
		this.operationStore = options.operationStore ?? new InMemoryV2OperationStore();
		this.processes = options.processes ?? new InMemoryV2ProcessRegistry();
		this.blobs = options.blobs ?? new InMemoryV2BlobStore();
		this.agents = options.agents ?? new InMemoryV2AgentRegistry();
		this.apps = options.apps ?? new InMemoryV2AppRegistry();
		this.plans = options.plans ?? new InMemoryV2PlanRegistry();
		this.inputs = options.inputs ?? new InMemoryV2InputRegistry();
		this.files =
			options.files ?? new LocalV2FileReferenceService({ projectRoot: process.cwd(), allowAbsolute: false });
		this.plugins = options.plugins ?? new InMemoryV2PluginRegistry();
		this.ownsAgents = options.agents === undefined;
	}

	get addresses(): readonly string[] {
		return this.listeners.flatMap((listener) => (listener.address === undefined ? [] : [listener.address]));
	}

	async start(): Promise<this> {
		if (this.startPromise) return this.startPromise;
		if (this.started || this.closing) throw new Error("PiServerV2 is already started or closing");
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	private async startInternal(): Promise<this> {
		try {
			await this.restoreStore();
			for (const listener of this.listeners) {
				await listener.start((connection) => this.accept(connection));
			}
			this.started = true;
			return this;
		} catch (error) {
			this.closing = true;
			const listenerResults = await Promise.allSettled(this.listeners.map((listener) => listener.close()));
			for (const result of listenerResults)
				if (result.status === "rejected")
					this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
			await Promise.all(Array.from(this.connections, (state) => this.closeConnection(state, undefined, true)));
			await this.disposeActiveOperationRuntimes();
			this.connections.clear();
			this.started = false;
			this.closing = false;
			this.startPromise = undefined;
			throw error;
		}
	}

	private async restoreStore(): Promise<void> {
		if (this.restored) return;
		const stored = await this.operationStore.load();
		for (const operation of stored.operations) this.operations.set(operation.operationId, operation);
		for (const event of stored.events) {
			const history = this.eventHistory.get(event.sessionId) ?? [];
			history.push(event);
			this.eventHistory.set(event.sessionId, history);
		}
		for (const events of this.eventHistory.values()) events.sort((a, b) => a.seq - b.seq);
		this.restored = true;
	}

	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void Promise.resolve(connection.close()).catch((error: unknown) =>
				this.reportError(error instanceof Error ? error : new Error(String(error))),
			);
			return { onData: () => {}, onClose: () => {}, onError: (error) => this.reportError(error) };
		}
		const state = this.createConnectionState(connection);
		this.connections.add(state);
		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.disconnect(state),
			onError: (error) => {
				this.reportError(error);
				void this.closeConnection(state);
			},
		};
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			try {
				await this.startPromise?.catch(() => undefined);
				const listenerResults = await Promise.allSettled(this.listeners.map((listener) => listener.close()));
				for (const result of listenerResults)
					if (result.status === "rejected")
						this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
				const connectionResults = await Promise.allSettled(
					Array.from(this.connections, (state) => this.closeConnection(state, undefined, true)),
				);
				for (const result of connectionResults)
					if (result.status === "rejected")
						this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
				await this.disposeActiveOperationRuntimes();
				const runtimeResults = await Promise.allSettled(Array.from(this.runtimes, (runtime) => this.disposeRuntime(runtime)));
				for (const result of runtimeResults)
					if (result.status === "rejected")
						this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
				this.runtimes.clear();
				if (this.ownsAgents) {
					const agentResult = await Promise.allSettled([this.agents.dispose?.()]);
					for (const result of agentResult)
						if (result.status === "rejected")
							this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
				}
			} finally {
				this.started = false;
			}
		})();
		return this.closePromise;
	}

	private createConnectionState(connection: ByteConnection): V2ConnectionState {
		const state = {
			id: randomUUID(),
			connection,
			decoder: new FrameDecoder({ maxFrameLength: this.maxFrameLength }),
			sessions: new Map<string, PiSessionRuntimeV2>(),
			controlSessions: new Set<string>(),
			attachedSessions: new Set<string>(),
			pendingAttachCounts: new Map<string, number>(),
			visibleSessions: new Set<string>(),
			attachingSessions: new Map<string, Promise<PiSessionRuntimeV2>>(),
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
			if (state.handshakePromise) return void this.failProtocol(state, "invalid_request", "Handshake already in progress");
			state.handshakePromise = this.handshake(state, message);
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
			const snapshot: ServerSnapshotV2 = {
				serverId: this.id,
				protocolVersion: PROTOCOL_V2_VERSION,
				revision: 0,
				eventSeq: 0,
				sessions: await this.service.listSessions(),
				models: await this.service.listModels(),
			};
			for (const session of snapshot.sessions) state.visibleSessions.add(session.id);
			await this.send(state, { type: "hello", version: PROTOCOL_V2_VERSION, connectionId: state.id, snapshot });
			if (message.lastEvent) {
				if (!state.visibleSessions.has(message.lastEvent.sessionId)) throw new Error("Replay session is not available");
				const events = this.eventHistory.get(message.lastEvent.sessionId) ?? [];
				const replay = events.filter((event) => event.seq > message.lastEvent!.eventSeq);
				if (replay.length > MAX_REPLAY_EVENTS) throw new Error("Replay exceeds configured limit");
				let replayBytes = 0;
				for (const event of replay) {
					const frame = encodeServerMessageV2(event, { maxFrameLength: this.maxFrameLength });
					replayBytes += frame.byteLength;
					if (replayBytes > MAX_REPLAY_BYTES) throw new Error("Replay exceeds configured limit");
					await this.send(state, event);
				}
			}
			state.ready = true;
			clearTimeout(state.handshakeTimeout);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid protocol request";
			await this.failProtocol(state, message.startsWith("Replay ") ? "invalid_request" : "internal_error", message);
		}
	}

	private async handleRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		try {
			if (command.command === "session/create") return void (await this.createSession(state, id, command));
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
			if (command.command === "operation/read") return void (await this.readOperation(state, id, command));
			if (command.command === "session/attach") return void (await this.attach(state, id, command));
			if (command.command === "session/read") return void (await this.readSession(state, id, command));
			if (command.command === "goal/read") return void (await this.readGoal(state, id, command));
			if (command.command === "process/start") return void (await this.startProcess(state, id, command));
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
			if (command.command === "input/request/read") return void (await this.readInputRequest(state, id, command));
			if (command.command === "input/request/respond")
				return void (await this.respondInputRequest(state, id, command));
			if (command.command === "input/request/cancel")
				return void (await this.cancelInputRequest(state, id, command));
			if (command.command === "filesystem/complete") return void (await this.completeFiles(state, id, command));
			if (command.command === "filesystem/reference/resolve")
				return void (await this.resolveFile(state, id, command));
			if (command.command === "filesystem/reference/read") return void (await this.readFile(state, id, command));
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
			if (command.command === "plugin/uninstall") return void (await this.uninstallPlugin(state, id, command));
			if (command.command === "plugin/enable") return void (await this.setPluginEnabled(state, id, command, true));
			if (command.command === "plugin/disable") return void (await this.setPluginEnabled(state, id, command, false));
			if (command.command === "session/detach") return void (await this.detach(state, id, command));
			if (
				command.command === "turn/start" ||
				command.command === "turn/steer" ||
				command.command === "turn/followUp" ||
				command.command === "turn/abort" ||
				command.command === "turn/resume" ||
				command.command === "turn/rollback" ||
				command.command === "goal/create" ||
				command.command === "goal/update" ||
				command.command === "goal/pause" ||
				command.command === "goal/resume" ||
				command.command === "session/model/set" ||
				command.command === "session/thinking/set" ||
				command.command === "session/name/set" ||
				command.command === "session/name/generate" ||
				command.command === "session/name/auto/set"
			)
				return void (await this.startTurn(state, id, command));
			await this.sendError(
				state,
				id,
				"not_implemented",
				`Command ${command.command} is not implemented in the v2 seam`,
			);
		} catch (error) {
			this.reportError(error instanceof Error ? error : new Error(String(error)));
			await this.sendError(state, id, "request_failed", "Request failed");
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
		const staleReference = Array.from(this.connections).some(
			(connection) =>
				connection.sessions.has(created.sessionId) ||
				connection.attachingSessions.has(created.sessionId) ||
				(connection.pendingAttachCounts.get(created.sessionId) ?? 0) > 0,
		);
		if (staleReference) {
			if (this.service.deleteSession)
				await this.service.deleteSession(created.sessionId).catch((cleanupError) => this.reportError(cleanupError));
			await this.disposeRuntime(created.runtime).catch((disposeError) => this.reportError(disposeError));
			throw new Error(`Session ${created.sessionId} still has stale connection references`);
		}
		this.deletedSessions.delete(created.sessionId);
		if (state.sessions.has(created.sessionId) || state.visibleSessions.has(created.sessionId)) {
			await this.disposeRuntime(created.runtime);
			throw new Error(`Session ${created.sessionId} is already attached`);
		}
		this.trackRuntime(created.runtime);
		state.sessions.set(created.sessionId, created.runtime);
		state.visibleSessions.add(created.sessionId);
		state.attachedSessions.add(created.sessionId);
		try {
			await this.sendResponse(state, id, {
				command: command.command,
				session: toProtocolJsonValue(await this.snapshotForSession(created.sessionId, created.runtime)),
			});
		} catch (error) {
			state.sessions.delete(created.sessionId);
			state.visibleSessions.delete(created.sessionId);
			state.attachedSessions.delete(created.sessionId);
			if (this.service.deleteSession) await this.service.deleteSession(created.sessionId).catch((cleanupError) => this.reportError(cleanupError));
			await this.disposeRuntime(created.runtime).catch((disposeError) => this.reportError(disposeError));
			throw error;
		}
	}

	private async deleteSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/delete requires sessionId");
		if (!this.service.deleteSession) throw new Error("session/delete is not supported by this service");
		this.requireVisibleSession(state, command.sessionId);
		const runtime = this.requireAttached(state, command.sessionId);
		if (this.deletingSessions.has(command.sessionId)) throw new Error("Session is already being deleted");
		const references = Array.from(this.connections).filter((connection) => connection !== state && connection.sessions.has(command.sessionId));
		if (references.length > 0 || this.hasActiveOperationForSession(command.sessionId))
			throw new Error("Session is still referenced by another connection or active operation");
		if (this.hasPendingAttachSession(command.sessionId)) throw new Error("Session has an attach in progress");
		this.deletingSessions.add(command.sessionId);
		try {
			await this.service.deleteSession(command.sessionId);
			this.deletedSessions.add(command.sessionId);
		} finally {
			this.deletingSessions.delete(command.sessionId);
		}
		state.sessions.delete(command.sessionId);
		state.visibleSessions.delete(command.sessionId);
		state.attachedSessions.delete(command.sessionId);
		if (runtime && !this.hasRuntimeReference(runtime)) await this.disposeRuntime(runtime);
		await this.sendResponse(state, id, { command: command.command, sessionId: command.sessionId });
	}

	private async attach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/attach requires sessionId");
		const payload = objectPayload(command);
		const mode = payload.mode === undefined ? "control" : payload.mode;
		if (mode !== "control" && mode !== "observer") throw new Error("session/attach mode must be control or observer");
		let runtime: PiSessionRuntimeV2 | undefined;
		let existing: PiSessionRuntimeV2 | undefined;
		let claimedControl = false;
		try {
			this.requireVisibleSession(state, command.sessionId);
			if (this.deletingSessions.has(command.sessionId) || this.deletedSessions.has(command.sessionId)) throw new Error("Session is unavailable");
			existing = state.sessions.get(command.sessionId);
			runtime = existing;
			if (!runtime) {
				let opening = state.attachingSessions.get(command.sessionId);
				if (!opening) {
					opening = this.service.openSession(command.sessionId);
					state.attachingSessions.set(command.sessionId, opening);
					void opening.finally(() => state.attachingSessions.delete(command.sessionId)).catch(() => undefined);
				}
				runtime = await opening;
			}
			if (!runtime) throw new Error("Session runtime is unavailable");
			this.trackRuntime(runtime);
			if (mode === "control") { this.claimControl(state, command.sessionId); claimedControl = true; }
			if (this.deletingSessions.has(command.sessionId) || this.deletedSessions.has(command.sessionId)) throw new Error("Session is unavailable");
			this.retainAttach(state, command.sessionId, runtime);
			if (state.closed || state.connection.closed) return;
			state.sessions.set(command.sessionId, runtime);
			const isCurrentAttachment = (): boolean =>
				!state.closed &&
				!state.connection.closed &&
				state.sessions.get(command.sessionId) === runtime;
			const snapshot = await this.snapshotForSession(command.sessionId, runtime);
			if (!isCurrentAttachment()) throw new PiServerError("invalid_request", "Session attachment was released");
			await this.sendResponse(state, id, {
				command: command.command,
				lease: mode,
				session: toProtocolJsonValue(snapshot),
			});
			// Detach may run while the transport send is pending. Do not restore
			// the map entry or otherwise claim the session after that detach.
			if (!isCurrentAttachment()) return;
			// The connection now has a committed attachment. A concurrent attach
			// request must not let its failure remove this shared runtime reference.
			state.attachedSessions.add(command.sessionId);
			if (mode === "observer") this.releaseControlFor(state, command.sessionId);
		} catch (error) {
			if (claimedControl && !state.attachedSessions.has(command.sessionId)) {
				this.releaseControlFor(state, command.sessionId);
				state.controlSessions.delete(command.sessionId);
			}
			if (
				runtime !== undefined &&
				existing === undefined &&
				state.sessions.get(command.sessionId) === runtime &&
				!state.attachedSessions.has(command.sessionId) &&
				!this.hasOtherPendingAttach(state, command.sessionId)
			) {
				state.sessions.delete(command.sessionId);
			}
			throw error;
		} finally {
			if (runtime !== undefined) await this.releaseAttach(state, command.sessionId, runtime);
		}
	}

	private async readSession(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/read requires sessionId");
		const runtime = this.requireAttached(state, command.sessionId);
		this.trackRuntime(runtime);
		await this.sendBoundedPluginResponse(state, id, {
			command: command.command,
			session: toProtocolJsonValue(await this.snapshotForSession(command.sessionId, runtime)),
		});
	}

	private async readGoal(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("goal/read requires sessionId");
		const runtime = this.requireAttached(state, command.sessionId);
		this.trackRuntime(runtime);
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
		const process = await this.processes.start({
			sessionId: command.sessionId,
			command: payload.command,
			...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
			...(typeof payload.pty === "boolean" ? { pty: payload.pty } : {}),
		});
		this.processSessions.set(process.processId, command.sessionId);
		await this.sendBoundedPluginResponse(state, id, {
			command: command.command,
			process: process as unknown as Record<string, unknown>,
		});
	}

	private async writeProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		this.requireResource(state, this.processSessions, processId, "process");
		this.requireControl(state, (await this.processes.getSnapshot(processId)).sessionId);
		if (typeof payload.input !== "string") throw new Error("process/write requires input");
		await this.sendResponse(state, id, {
			command: command.command,
			output: await this.processes.write(processId, payload.input),
		});
	}

	private async readProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		this.requireResource(state, this.processSessions, processId, "process");
		const cursor = typeof payload.cursor === "number" ? payload.cursor : 0;
		await this.sendResponse(state, id, {
			command: command.command,
			output: await this.processes.read(processId, cursor),
		});
	}

	private async waitProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		this.requireResource(state, this.processSessions, processIdFrom(command, payload), "process");
		await this.sendResponse(state, id, {
			command: command.command,
			process: await this.processes.wait(processIdFrom(command, payload)),
		});
	}

	private async terminateProcess(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const processId = processIdFrom(command, payload);
		this.requireResource(state, this.processSessions, processId, "process");
		this.requireControl(state, (await this.processes.getSnapshot(processId)).sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			process: await this.processes.terminate(processId),
		});
	}

	private async putBlob(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.data !== "string" || typeof payload.mimeType !== "string")
			throw new Error("blob/put requires data and mimeType");
		const encoding = payload.encoding === "base64" ? "base64" : payload.encoding === "utf8" ? "utf8" : undefined;
		if (!encoding) throw new Error("blob/put encoding must be utf8 or base64");
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
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.taskName !== "string" || typeof payload.taskMessage !== "string")
			throw new Error("agent/spawn requires taskName and taskMessage");
		const modelPayload =
			typeof payload.model === "object" && payload.model !== null && !Array.isArray(payload.model)
				? (payload.model as Record<string, unknown>)
				: {};
		const agent = await this.agents.spawn({
			sessionId: command.sessionId,
			parentPath: typeof payload.parentPath === "string" ? payload.parentPath : "/root",
			taskName: payload.taskName,
			taskMessage: payload.taskMessage,
			...(typeof payload.role === "string" ? { role: payload.role } : {}),
			model: {
				provider: typeof modelPayload.provider === "string" ? modelPayload.provider : "inherit",
				id: typeof modelPayload.id === "string" ? modelPayload.id : "inherit",
			},
		});
		this.agentSessions.set(agent.id, command.sessionId);
		await this.sendResponse(state, id, { command: command.command, agent });
		const runtime = state.sessions.get(command.sessionId);
		if (runtime) {
			await this.broadcastEvent(command.sessionId, runtime, { agent }, undefined, "agent_updated");
			this.watchAgent(command.sessionId, runtime, agent.id);
		}
	}

	private async listAgents(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("agent/list requires sessionId");
		this.requireAttached(state, command.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			agents: await this.agents.list(command.sessionId),
		});
	}

	private async waitAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		this.requireResource(state, this.agentSessions, agentId, "agent");
		await this.sendResponse(state, id, {
			command: command.command,
			agent: await this.agents.wait(agentId, typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined),
		});
	}

	private async messageAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		this.requireControl(state, (await this.agents.getSnapshot(agentId)).sessionId);
		this.requireResource(state, this.agentSessions, agentId, "agent");
		if (typeof payload.message !== "string") throw new Error("agent/message requires message");
		const message = payload.message;
		await this.agents.message(agentId, message);
		await this.sendResponse(state, id, { command: command.command, agentId });
		const sessionId = (await this.agents.getSnapshot(agentId)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) await this.broadcastEvent(sessionId, runtime, { agentId, message: safeAgentMessage(message) }, undefined, "agent_message");
	}

	private async followUpAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const agentId = agentIdFrom(command, payload);
		this.requireControl(state, (await this.agents.getSnapshot(agentId)).sessionId);
		this.requireResource(state, this.agentSessions, agentId, "agent");
		if (typeof payload.message !== "string") throw new Error("agent/followUp requires message");
		const agent = await this.agents.followUp(agentId, payload.message);
		await this.sendResponse(state, id, {
			command: command.command,
			agent,
		});
		const sessionId = (await this.agents.getSnapshot(agentId)).sessionId;
		const runtime = state.sessions.get(sessionId);
		if (runtime) {
			await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
			this.watchAgent(sessionId, runtime, agent.id);
		}
	}

	private async interruptAgent(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		this.requireControl(state, (await this.agents.getSnapshot(agentIdFrom(command, payload))).sessionId);
		this.requireResource(state, this.agentSessions, agentIdFrom(command, payload), "agent");
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

	private watchAgent(sessionId: string, runtime: PiSessionRuntimeV2, agentId: string): void {
		const key = `${sessionId}:${agentId}`;
		const existing = this.agentWatches.get(key);
		if (existing) {
			existing.rerun = true;
			return;
		}
		const watch = { rerun: false };
		this.agentWatches.set(key, watch);
		void (async () => {
			try {
				while (!this.closing) {
					const agent = await this.agents.wait(agentId);
					if (this.closing) return;
					await this.broadcastEvent(sessionId, runtime, { agent }, undefined, "agent_updated");
					if (watch.rerun) {
						watch.rerun = false;
						continue;
					}
					const current = await this.agents.getSnapshot(agentId);
					if (current.state === "running" || current.state === "awaitingInput" || watch.rerun) {
						watch.rerun = false;
						continue;
					}
					break;
				}
			} catch (error) {
				this.reportError(error instanceof Error ? error : new Error(String(error)));
			} finally {
				this.agentWatches.delete(key);
			}
		})();
	}

	private async listApps(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		await this.sendResponse(state, id, { command: command.command, apps: await this.apps.list() });
	}

	private async readApp(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/read requires id");
		const app = await this.apps.read(payload.id);
		if (!app) throw new Error(`Unknown app: ${payload.id}`);
		await this.sendResponse(state, id, { command: command.command, app });
	}

	private async startAppAuth(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/auth/start requires id");
		await this.sendResponse(state, id, {
			command: command.command,
			auth: await this.apps.startAuth(payload.id, payload),
		});
	}

	private async completeAppAuth(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("app/auth/complete requires id");
		if (typeof payload.nonce !== "string" || payload.nonce.length === 0 || payload.nonce.length > 128)
			throw new Error("app/auth/complete requires bounded nonce");
		if (payload.authenticated !== undefined && typeof payload.authenticated !== "boolean")
			throw new Error("app/auth/complete authenticated must be boolean");
		await this.apps.completeAuth(payload.id, payload);
		await this.sendResponse(state, id, { command: command.command, appId: payload.id, state: "completed" });
	}

	private async snapshotForSession(sessionId: string, runtime: PiSessionRuntimeV2): Promise<SessionSnapshotV2> {
		const snapshot = await runtime.snapshot();
		const agents = await this.agents.list(sessionId);
		const plan = await this.plans.read(sessionId);
		const pendingInputRequestId = await this.inputs.pendingForSession(sessionId);
		return {
			...snapshot,
			...(agents.length === 0 ? {} : { agents: [...agents] }),
			...(plan === undefined ? {} : { plan }),
			queues: {
				...snapshot.queues,
				...(pendingInputRequestId === undefined ? {} : { pendingInputRequestId }),
			},
		};
	}

	private async readPlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/read requires sessionId");
		this.requireAttached(state, command.sessionId);
		const plan = await this.plans.read(command.sessionId);
		await this.sendResponse(
			state,
			id,
			plan === undefined ? { command: command.command } : { command: command.command, plan },
		);
	}

	private async updatePlan(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("plan/update requires sessionId");
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > MAX_V2_ARRAY_ITEMS)
			throw new Error("plan/update requires one to 10000 items");
		const items = payload.items.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item))
				throw new Error("plan/update items must be objects");
			const candidate = item as Record<string, unknown>;
			if (typeof candidate.step !== "string" || candidate.step.trim().length === 0 || candidate.step.length > MAX_V2_STRING_LENGTH)
				throw new Error("plan/update item step must be a non-empty string");
			if (candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "completed")
				throw new Error("plan/update item status is invalid");
			return { step: candidate.step, status: candidate.status };
		});
		if (payload.version !== undefined && (!Number.isSafeInteger(payload.version) || payload.version < 1))
			throw new Error("plan/update version must be a positive safe integer");
		const plan = await this.plans.update(command.sessionId, {
			items,
			...(typeof payload.version === "number" ? { version: payload.version } : {}),
		});
		await this.sendResponse(state, id, { command: command.command, plan });
	}

	private async readInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestId = requestIdFrom(command, objectPayload(command));
		const request = await this.inputs.read(requestId);
		this.requireAttached(state, request.sessionId);
		this.inputSessions.set(request.id, request.sessionId);
		await this.sendResponse(state, id, { command: command.command, request });
	}

	private async respondInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const payload = objectPayload(command);
		const requestId = requestIdFrom(command, payload);
		this.requireResource(state, this.inputSessions, requestId, "input request");
		if (typeof payload.answers !== "object" || payload.answers === null || Array.isArray(payload.answers))
			throw new Error("input/request/respond requires answers");
		const answers = Object.fromEntries(
			Object.entries(payload.answers as Record<string, unknown>).map(([key, value]) => {
				if (typeof value !== "string") throw new Error(`Answer ${key} must be a string`);
				return [key, value];
			}),
		);
		await this.sendResponse(state, id, {
			command: command.command,
			request: await this.inputs.respond(requestId, answers),
		});
	}

	private async cancelInputRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		const requestId = requestIdFrom(command, objectPayload(command));
		this.requireResource(state, this.inputSessions, requestId, "input request");
		await this.sendResponse(state, id, { command: command.command, request: await this.inputs.cancel(requestId) });
	}

	private async completeFiles(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/complete requires sessionId");
		this.requireAttached(state, command.sessionId);
		const payload = objectPayload(command);
		const prefix = typeof payload.prefix === "string" ? payload.prefix : "";
		await this.sendResponse(state, id, {
			command: command.command,
			items: await this.files.complete(command.sessionId, prefix),
		});
	}

	private async resolveFile(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/reference/resolve requires sessionId");
		this.requireAttached(state, command.sessionId);
		await this.sendResponse(state, id, {
			command: command.command,
			file: await this.files.resolve(command.sessionId, referenceFrom(command, objectPayload(command))),
		});
	}

	private async readFile(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("filesystem/reference/read requires sessionId");
		this.requireAttached(state, command.sessionId);
		const result = await this.files.read(command.sessionId, referenceFrom(command, objectPayload(command)));
		const response = {
			command: command.command,
			file: result.file,
			encoding: "base64",
			data: Buffer.from(result.data).toString("base64"),
		};
		try {
			encodeServerMessageV2(
				{ type: "response", id, ok: true, result: toProtocolJsonValue(response) },
				{ maxFrameLength: this.maxFrameLength },
			);
		} catch {
			throw new Error("File response exceeds the maximum frame size");
		}
		await this.sendResponse(state, id, {
			...response,
		});
	}

	private async diagnosticsStatus(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const events = await this.diagnosticEvents();
		await this.sendResponse(state, id, {
			command: command.command,
			capture: "metadata",
			degraded: false,
			lastCriticalEventSeq: events.at(-1)?.seq ?? 0,
			eventCount: events.length,
		});
	}

	private async diagnosticsTimeline(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		const events = await this.diagnosticEvents(typeof payload.afterSeq === "number" ? payload.afterSeq : 0);
		await this.sendBoundedDiagnosticsResponse(state, id, {
			command: command.command,
			events: events
			.filter(
				(event) =>
					(typeof payload.sessionId !== "string" || event.sessionId === payload.sessionId) &&
					(typeof payload.operationId !== "string" || event.operationId === payload.operationId),
			)
			.slice(0, MAX_REPLAY_EVENTS),
		});
	}

	private async diagnosticsExport(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		await this.sendBoundedDiagnosticsResponse(state, id, {
			command: command.command,
			format: "json",
			events: (await this.diagnosticEvents()).slice(0, MAX_REPLAY_EVENTS),
		});
	}

	private async sendBoundedDiagnosticsResponse(
		state: V2ConnectionState,
		id: string,
		result: Record<string, unknown>,
	): Promise<void> {
		try {
			encodeServerMessageV2(
				{ type: "response", id, ok: true, result: toProtocolJsonValue(result) },
				{ maxFrameLength: this.maxFrameLength },
			);
		} catch {
			throw new Error("Diagnostics response exceeds the maximum frame size");
		}
		await this.sendResponse(state, id, result);
	}

	private async diagnosticsVerify(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const events = await this.diagnosticEvents();
		const gaps = events.slice(1).flatMap((event, index) => {
			const previous = events[index];
			return previous && event.seq !== previous.seq + 1 ? [{ from: previous.seq, to: event.seq }] : [];
		});
		await this.sendResponse(state, id, { command: command.command, valid: gaps.length === 0, gaps });
	}

	private async diagnosticsDoctor(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const events = await this.diagnosticEvents();
		const sequenceOk = events.every((event, index) => index === 0 || event.seq === events[index - 1]!.seq + 1);
		await this.sendResponse(state, id, {
			command: command.command,
			ok: sequenceOk,
			checks: [
				{ name: "recorder", ok: true },
				{ name: "sequence", ok: sequenceOk },
			],
		});
	}

	private async addMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.name !== "string" || typeof payload.source !== "string")
			throw new Error("marketplace/add requires name and source");
		await this.sendResponse(state, id, {
			command: command.command,
			marketplace: await this.plugins.addMarketplace(payload.name, payload.source),
		});
	}

	private async listMarketplaces(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		await this.sendBoundedPluginResponse(state, id, {
			command: command.command,
			marketplaces: (await this.plugins.listMarketplaces()).slice(0, MAX_V2_ARRAY_ITEMS),
		});
	}

	private async upgradeMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.name !== "string") throw new Error("marketplace/upgrade requires name");
		await this.sendResponse(state, id, {
			command: command.command,
			marketplace: await this.plugins.upgradeMarketplace(payload.name),
		});
	}

	private async removeMarketplace(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.name !== "string") throw new Error("marketplace/remove requires name");
		await this.plugins.removeMarketplace(payload.name);
		await this.sendResponse(state, id, { command: command.command, name: payload.name });
	}

	private async listPlugins(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		await this.sendBoundedPluginResponse(state, id, {
			command: command.command,
			plugins: (await this.plugins.listPlugins(payload.installedOnly === true)).slice(0, MAX_V2_ARRAY_ITEMS),
		});
	}

	private async readPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("plugin/read requires id");
		const plugin = await this.plugins.readPlugin(payload.id);
		if (!plugin) throw new Error(`Unknown plugin: ${payload.id}`);
		await this.sendBoundedPluginResponse(state, id, { command: command.command, plugin });
	}

	private async installPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (
			typeof payload.name !== "string" ||
			typeof payload.marketplace !== "string" ||
			typeof payload.version !== "string" ||
			typeof payload.manifest !== "object" ||
			payload.manifest === null ||
			Array.isArray(payload.manifest)
		)
			throw new Error("plugin/install requires name, marketplace, version, and manifest");
		const manifest = payload.manifest as Record<string, unknown>;
		const boundedResources = (value: unknown): string[] =>
			Array.isArray(value)
				? value
						.filter((item): item is string => typeof item === "string")
						.slice(0, 256)
						.map((item) => item.slice(0, 1024))
				: [];
		const preview = {
			id: `${payload.name}@${payload.marketplace}`,
			name: payload.name,
			marketplace: payload.marketplace,
			version: payload.version,
			manifestDigest: "0".repeat(64),
			...(typeof payload.root === "string" ? { root: payload.root } : {}),
			enabled: true,
			scope: payload.scope === "project" ? "project" : "user",
			provenance: "manifest",
			resources: {
				skills: boundedResources(manifest.skills),
				commands: boundedResources(manifest.commands),
				apps: Array.isArray(manifest.apps) ? manifest.apps.length : manifest.apps === undefined ? 0 : 1,
				hooks: Array.isArray(manifest.hooks) ? manifest.hooks.length : manifest.hooks === undefined ? 0 : 1,
			},
		};
		try {
			encodeServerMessageV2(
				{ type: "response", id, ok: true, result: toProtocolJsonValue({ command: command.command, plugin: preview }) },
				{ maxFrameLength: this.maxFrameLength },
			);
		} catch {
			throw new Error("Plugin response exceeds the maximum frame size");
		}
		await this.sendBoundedPluginResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.installPlugin({
				name: payload.name,
				marketplace: payload.marketplace,
				version: payload.version,
				manifest,
				...(typeof payload.root === "string" ? { root: payload.root } : {}),
				...(payload.scope === "user" || payload.scope === "project" ? { scope: payload.scope } : {}),
			}),
		});
	}

	private async uninstallPlugin(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error("plugin/uninstall requires id");
		await this.plugins.uninstallPlugin(payload.id);
		await this.sendResponse(state, id, { command: command.command, id: payload.id });
	}

	private async setPluginEnabled(
		state: V2ConnectionState,
		id: string,
		command: CommandV2,
		enabled: boolean,
	): Promise<void> {
		this.requireControl(state, command);
		const payload = objectPayload(command);
		if (typeof payload.id !== "string") throw new Error(`${command.command} requires id`);
		await this.sendResponse(state, id, {
			command: command.command,
			plugin: await this.plugins.setEnabled(
				payload.id,
				enabled,
				payload.scope === "user" || payload.scope === "project" ? payload.scope : undefined,
			),
		});
	}

	private requireControl(state: V2ConnectionState, command: CommandV2 | string): void {
		const sessionId = typeof command === "string" ? command : command.sessionId;
		if (!sessionId) throw new Error(typeof command === "string" ? "Session ID is required" : `${command.command} requires sessionId`);
		if (this.controls.get(sessionId) === state.id) {
			this.requireAttached(state, sessionId);
			return;
		}
		throw new Error(`Session ${sessionId} requires a control lease`);
	}

	private async sendBoundedPluginResponse(state: V2ConnectionState, id: string, result: Record<string, unknown>): Promise<void> {
		try {
			encodeServerMessageV2(
				{ type: "response", id, ok: true, result: toProtocolJsonValue(result) },
				{ maxFrameLength: this.maxFrameLength },
			);
		} catch {
			throw new Error("Plugin response exceeds the maximum frame size");
		}
		await this.sendResponse(state, id, result);
	}

	private async diagnosticEvents(afterSeq = 0): Promise<Awaited<ReturnType<ForensicRecorder["read"]>>> {
		return this.diagnostics.read(afterSeq);
	}

	private async detach(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("session/detach requires sessionId");
		this.requireAttached(state, command.sessionId);
		const runtime = state.sessions.get(command.sessionId);
		state.sessions.delete(command.sessionId);
		state.attachedSessions.delete(command.sessionId);
		this.releaseControlFor(state, command.sessionId);
		if (runtime && !this.hasRuntimeReference(runtime) && !this.hasActiveOperation(runtime) && !this.hasPendingAttach(runtime)) await this.disposeRuntime(runtime);
		await this.sendResponse(state, id, { command: command.command, sessionId: command.sessionId });
	}

	private requireVisibleSession(state: V2ConnectionState, sessionId: string): void {
		if (!state.visibleSessions?.has(sessionId)) throw new Error("Session is not available to this connection");
	}

	private requireAttached(state: V2ConnectionState, sessionId: string): PiSessionRuntimeV2 {
		this.requireVisibleSession(state, sessionId);
		const runtime = state.sessions.get(sessionId);
		if (!runtime) throw new Error("Session is not attached to this connection");
		return runtime;
	}

	private requireResource(state: V2ConnectionState, owners: Map<string, string>, resourceId: string, label: string): void {
		const sessionId = owners.get(resourceId);
		if (sessionId === undefined) throw new Error(`${label} is not available`);
		this.requireAttached(state, sessionId);
	}

	private async startTurn(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.sessionId) throw new Error("turn/start requires sessionId");
		if (this.deletingSessions.has(command.sessionId)) throw new Error("Session is being deleted");
		this.requireControl(state, command);
		const runtime = this.requireAttached(state, command.sessionId);
		const resolvedCommand = await this.resolveTurnContent(command);
		const operationId = randomUUID();
		this.retainOperation(runtime, command.sessionId);
		let accepted: OperationAccepted;
		try {
			accepted = await runtime.accept(operationId);
		} catch (error) {
			this.releaseOperation(runtime, command.sessionId);
			if (!this.hasRuntimeReference(runtime) && !this.hasActiveOperation(runtime) && !this.hasPendingAttach(runtime)) {
				try {
					await this.disposeRuntime(runtime);
				} catch (disposeError) {
					this.reportError(disposeError instanceof Error ? disposeError : new Error(String(disposeError)));
				}
			}
			throw error;
		}
		this.operations.set(operationId, {
			operationId,
			sessionId: command.sessionId,
			state: "accepted",
			accepted,
		});
		try {
			await this.operationStore.putOperation(this.operations.get(operationId)!);
			await this.send(state, { type: "response", id, ok: true, accepted });
			await this.broadcastEvent(
				command.sessionId,
				runtime,
				{ state: "accepted", accepted },
				operationId,
				"operation_accepted",
				{ eventSeq: accepted.eventSeq, revision: accepted.sessionRevision },
			);
			void this.recordDiagnostic({
				kind: "operation_accepted",
				sessionId: command.sessionId,
				operationId,
				payload: { command: command.command, payload: command.payload },
			});
		} catch (error) {
			this.reportError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			void this.runOperation(runtime, command.sessionId, operationId, resolvedCommand).catch((error: unknown) =>
				this.reportError(error instanceof Error ? error : new Error(String(error))),
			);
		}
	}

	private async resolveTurnContent(command: CommandV2): Promise<CommandV2> {
		const payload = objectPayload(command);
		if (!Array.isArray(payload.content)) return command;
		if (payload.content.length > 64) throw new Error("turn content has too many parts");
		const content: unknown[] = [];
		let totalBytes = 0;
		for (const [index, part] of payload.content.entries()) {
			if (typeof part !== "object" || part === null || Array.isArray(part)) throw new Error(`turn content item ${index} must be an object`);
			const item = part as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") { content.push({ type: "text", text: item.text }); continue; }
			if (item.type !== "image" && item.type !== "blob") throw new Error(`turn content item ${index} must be text, image, or blob`);
			if (typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/")) throw new Error(`turn content item ${index} requires an image MIME type`);
			if (typeof item.data === "string") { totalBytes += item.data.length; if (totalBytes > 16 * 1024 * 1024) throw new Error("turn content exceeds size limit"); content.push({ type: "image", data: item.data, mimeType: item.mimeType }); continue; }
			if (typeof item.digest !== "string") throw new Error(`turn content item ${index} requires a blob digest`);
			const stat = await this.blobs.stat(item.digest);
			if (!stat.mimeType.startsWith("image/") || stat.size > 16 * 1024 * 1024) throw new Error("blob is not a bounded image");
			const data = await this.blobs.read(item.digest);
			totalBytes += data.byteLength;
			if (totalBytes > 16 * 1024 * 1024) throw new Error("turn content exceeds size limit");
			content.push({ type: "image", data: Buffer.from(data).toString("base64"), mimeType: stat.mimeType });
		}
		return { ...command, payload: toProtocolJsonValue({ ...payload, content }) };
	}

	private async runOperation(
		runtime: PiSessionRuntimeV2,
		sessionId: string,
		operationId: string,
		command: CommandV2,
	): Promise<void> {
		try {
			await runtime.run(operationId, command);
			await this.finalizeOperation(runtime, sessionId, operationId, "complete");
		} catch (error) {
			await this.finalizeOperation(runtime, sessionId, operationId, "failed", safeOperationError(error));
		} finally {
			this.releaseOperation(runtime, sessionId);
			if (!this.hasRuntimeReference(runtime) && !this.hasActiveOperation(runtime) && !this.hasPendingAttach(runtime)) await this.disposeRuntime(runtime);
		}
	}

	private async finalizeOperation(runtime: PiSessionRuntimeV2, sessionId: string, operationId: string, state: "complete" | "failed", error?: string): Promise<void> {
		const record = this.operations.get(operationId);
		if (!record) return;
		const terminal = { ...record, state, ...(error === undefined ? {} : { error }) };
		this.operations.set(operationId, terminal);
		await this.tryOperationEffect(() => this.operationStore.putOperation(terminal));
		let snapshot: SessionSnapshotV2 | undefined;
		try { snapshot = await runtime.snapshot(); } catch (cause) { this.reportError(cause instanceof Error ? cause : new Error(String(cause))); }
		try {
			await this.broadcastEvent(sessionId, runtime, { state, ...(error === undefined ? {} : { error }), ...(snapshot === undefined ? {} : { snapshot: toProtocolJsonValue(snapshot) }) }, operationId, "operation_terminal");
		} catch (cause) { this.reportError(cause instanceof Error ? cause : new Error(String(cause))); }
		if (snapshot !== undefined) {
			const current = this.operations.get(operationId);
			if (current) {
				const withCursor = { ...current, terminalSeq: snapshot.eventSeq };
				this.operations.set(operationId, withCursor);
				await this.tryOperationEffect(() => this.operationStore.putOperation(withCursor));
			}
		}
		await this.recordDiagnostic({ kind: "operation_terminal", sessionId, operationId, payload: { state, ...(error === undefined ? {} : { error }) } });
	}

	private async tryOperationEffect(effect: () => Promise<void>): Promise<void> {
		try { await effect(); } catch (cause) { this.reportError(cause instanceof Error ? cause : new Error(String(cause))); }
	}

	private async readOperation(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		if (!command.operationId) throw new Error("operation/read requires operationId");
		const operation = this.operations.get(command.operationId);
		if (!operation) throw new Error(`Unknown operation ${command.operationId}`);
		this.requireAttached(state, operation.sessionId);
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
		const previous = this.broadcastTails.get(sessionId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(() =>
			this.broadcastEventInternal(sessionId, runtime, payload, operationId, eventName, sequence),
		);
		this.broadcastTails.set(sessionId, current);
		try {
			await current;
		} finally {
			if (this.broadcastTails.get(sessionId) === current) this.broadcastTails.delete(sessionId);
		}
	}

	private async broadcastEventInternal(
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
		if (history.length > 256) history.splice(0, history.length - 256);
		this.eventHistory.set(sessionId, history);
		await this.operationStore.appendEvent(event);
		const sends = await Promise.allSettled(
			Array.from(this.connections)
				.filter((connection) => connection.sessions.get(sessionId) === runtime)
				.map((connection) => this.send(connection, event)),
		);
		for (const result of sends)
			if (result.status === "rejected") this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
	}

	private sendResponse(state: V2ConnectionState, id: string, result: Record<string, unknown>): Promise<void> {
		return this.send(state, { type: "response", id, ok: true, result: toProtocolJsonValue(result) });
	}

	private sendError(state: V2ConnectionState, id: string, code: string, message: string): Promise<void> {
		return this.send(state, { type: "response", id, ok: false, error: { code, message } });
	}

	private async send(state: V2ConnectionState, message: ServerMessageV2): Promise<void> {
		if (state.closed) return;
		try {
			await state.connection.send(encodeServerMessageV2(message, { maxFrameLength: this.maxFrameLength }));
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.reportError(failure);
			await this.closeConnection(state);
			throw failure;
		}
	}

	private async failProtocol(state: V2ConnectionState, code: string, message: string): Promise<void> {
		if (state.closed) return;
		const safeMessage =
			code === "unsupported_version"
				? "Unsupported protocol version"
				: code === "invalid_request" && (message === "Replay exceeds configured limit" || message === "Replay session is not available")
					? message
					: "Invalid protocol request";
		await this.closeConnection(state, encodeServerMessageV2({ type: "hello_error", error: { code, message: safeMessage } }, { maxFrameLength: this.maxFrameLength }));
	}

	private async closeConnection(state: V2ConnectionState, finalChunk?: Uint8Array, forceDispose = false): Promise<void> {
		if (state.disconnectPromise) return state.disconnectPromise;
		state.closed = true;
		clearTimeout(state.handshakeTimeout);
		state.disconnectPromise = (async () => {
			for (const sessionId of state.controlSessions) this.releaseControlFor(state, sessionId);
		const runtimes = new Set(state.sessions.values());
		state.sessions.clear();
		state.attachedSessions.clear();
		state.pendingAttachCounts.clear();
			const disposals = Array.from(runtimes)
				.filter(
					(runtime) =>
						forceDispose ||
						(!this.hasActiveOperation(runtime) && !this.hasPendingAttach(runtime) && !this.hasRuntimeReference(runtime)),
				)
				.map((runtime) => this.disposeRuntime(runtime));
			const disposalResults = await Promise.allSettled(disposals);
			for (const result of disposalResults)
				if (result.status === "rejected")
					this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
			try {
				await state.connection.close(finalChunk);
			} catch (error) {
				this.reportError(error instanceof Error ? error : new Error(String(error)));
			} finally {
				this.connections.delete(state);
			}
		})();
		return state.disconnectPromise;
	}

	private disconnect(state: V2ConnectionState): Promise<void> {
		for (const sessionId of state.controlSessions) this.releaseControlFor(state, sessionId);
		return this.closeConnection(state);
	}

	private claimControl(state: V2ConnectionState, sessionId: string): void {
		const owner = this.controls.get(sessionId);
		if (owner !== undefined && owner !== state.id)
			throw new Error(`Session ${sessionId} already has a control lease`);
		this.controls.set(sessionId, state.id);
		state.controlSessions.add(sessionId);
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

	private retainOperation(runtime: PiSessionRuntimeV2, sessionId: string): void {
		this.activeOperations.set(runtime, (this.activeOperations.get(runtime) ?? 0) + 1);
		this.activeOperationSessions.set(sessionId, (this.activeOperationSessions.get(sessionId) ?? 0) + 1);
	}

	private releaseOperation(runtime: PiSessionRuntimeV2, sessionId: string): void {
		const count = this.activeOperations.get(runtime);
		if (count === undefined || count <= 1) this.activeOperations.delete(runtime);
		else this.activeOperations.set(runtime, count - 1);
		const sessionCount = this.activeOperationSessions.get(sessionId) ?? 0;
		if (sessionCount <= 1) this.activeOperationSessions.delete(sessionId);
		else this.activeOperationSessions.set(sessionId, sessionCount - 1);
	}

	private hasActiveOperation(runtime: PiSessionRuntimeV2): boolean {
		return (this.activeOperations.get(runtime) ?? 0) > 0;
	}

	private hasActiveOperationForSession(sessionId: string): boolean {
		return (this.activeOperationSessions.get(sessionId) ?? 0) > 0;
	}

	private retainAttach(state: V2ConnectionState, sessionId: string, runtime: PiSessionRuntimeV2): void {
		this.pendingAttaches.set(runtime, (this.pendingAttaches.get(runtime) ?? 0) + 1);
		state.pendingAttachCounts.set(sessionId, (state.pendingAttachCounts.get(sessionId) ?? 0) + 1);
	}

	private async releaseAttach(state: V2ConnectionState, sessionId: string, runtime: PiSessionRuntimeV2): Promise<void> {
		const sessionCount = state.pendingAttachCounts.get(sessionId);
		if (sessionCount === undefined || sessionCount <= 1) state.pendingAttachCounts.delete(sessionId);
		else state.pendingAttachCounts.set(sessionId, sessionCount - 1);
		const count = this.pendingAttaches.get(runtime);
		if (count === undefined) return;
		if (count <= 1) this.pendingAttaches.delete(runtime);
		else this.pendingAttaches.set(runtime, count - 1);
		// A concurrent attach may have observed the runtime after another
		// request installed it in the connection map, while every attach
		// request ultimately failed before committing ownership. Remove that
		// provisional map entry when the final pending lease is released so a
		// disposed runtime can never remain addressable on this connection.
		if (
			!this.hasPendingAttach(runtime) &&
			!state.attachedSessions.has(sessionId) &&
			state.sessions.get(sessionId) === runtime
		) {
			state.sessions.delete(sessionId);
		}
		if (this.hasRuntimeReference(runtime) || this.hasActiveOperation(runtime) || this.hasPendingAttach(runtime)) return;
		try {
			await this.disposeRuntime(runtime);
		} catch (error) {
			this.reportError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private hasPendingAttach(runtime: PiSessionRuntimeV2): boolean {
		return (this.pendingAttaches.get(runtime) ?? 0) > 0;
	}

	private hasPendingAttachSession(sessionId: string): boolean {
		return Array.from(this.connections).some((connection) => (connection.pendingAttachCounts.get(sessionId) ?? 0) > 0);
	}

	private hasOtherPendingAttach(state: V2ConnectionState, sessionId: string): boolean {
		return (state.pendingAttachCounts.get(sessionId) ?? 0) > 1;
	}

	private trackRuntime(runtime: PiSessionRuntimeV2): void {
		this.runtimes.add(runtime);
	}

	private async disposeRuntime(runtime: PiSessionRuntimeV2): Promise<void> {
		if (this.disposedRuntimes.has(runtime)) return;
		this.disposedRuntimes.add(runtime);
		try {
			await runtime.dispose();
		} finally {
			this.runtimes.delete(runtime);
		}
	}

	private async disposeActiveOperationRuntimes(): Promise<void> {
		const results = await Promise.allSettled(
			Array.from(this.activeOperations.keys(), (runtime) => this.disposeRuntime(runtime)),
		);
		for (const result of results)
			if (result.status === "rejected")
				this.reportError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
	}

	private reportError(error: Error): void {
		const diagnosticMessage = safeDiagnosticMessage(error);
		void this.diagnostics?.record({ kind: "server_error", payload: { message: diagnosticMessage } }).catch(() => {});
		this.notifyError(error);
	}

	private notifyError(error: Error): void {
		try {
			this.onError?.(error);
		} catch {
			return;
		}
	}

	private async recordDiagnostic(event: Parameters<ForensicRecorder["record"]>[0]): Promise<void> {
		try {
			await this.diagnostics?.record(event);
		} catch (error) {
			this.notifyError(error instanceof Error ? error : new Error(String(error)));
		}
	}
}
