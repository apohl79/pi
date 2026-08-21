import { randomUUID } from "node:crypto";
import {
	type ClientHelloV2,
	type CommandV2,
	ClientMessageV2Decoder,
	type EventEnvelopeV2,
	encodeServerMessageV2,
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
import { InMemoryV2BlobStore, type V2BlobStore } from "./blobs.ts";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import type { ForensicRecorder } from "./diagnostics.ts";
import { InMemoryV2InputRegistry, type V2InputRegistry } from "./inputs.ts";
import type { PiServerListener } from "./listener.ts";
import { InMemoryV2OperationStore, type V2OperationStore } from "./operation-store.ts";
import { InMemoryV2PlanRegistry, type V2PlanRegistry } from "./plans.ts";
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
	plans?: V2PlanRegistry;
	inputs?: V2InputRegistry;
}

type V2ConnectionState = {
	id: string;
	connection: ByteConnection;
	decoder: ClientMessageV2Decoder;
	sessions: Map<string, PiSessionRuntimeV2>;
	ready: boolean;
	closed: boolean;
	handshakeTimeout: NodeJS.Timeout;
	handshake?: Promise<void>;
};

const DEFAULT_MAX_FRAME_LENGTH = 4 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_REPLAY_EVENTS = 1_024;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;

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

export class PiServerV2 {
	readonly id: string;
	private readonly listeners: readonly PiServerListener[];
	private readonly service: PiServerServiceV2;
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly diagnostics: ForensicRecorder | undefined;
	private readonly operationStore: V2OperationStore;
	private readonly processes: V2ProcessRegistry;
	private readonly blobs: V2BlobStore;
	private readonly agents: V2AgentRegistry;
	private readonly plans: V2PlanRegistry;
	private readonly inputs: V2InputRegistry;
	private readonly connections = new Set<V2ConnectionState>();
	private readonly eventHistory = new Map<string, EventEnvelopeV2[]>();
	private readonly operations = new Map<string, OperationRecordV2>();
	private readonly disposedRuntimes = new WeakSet<PiSessionRuntimeV2>();
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
		this.diagnostics = options.diagnostics;
		this.operationStore = options.operationStore ?? new InMemoryV2OperationStore();
		this.processes = options.processes ?? new InMemoryV2ProcessRegistry();
		this.blobs = options.blobs ?? new InMemoryV2BlobStore();
		this.agents = options.agents ?? new InMemoryV2AgentRegistry();
		this.plans = options.plans ?? new InMemoryV2PlanRegistry();
		this.inputs = options.inputs ?? new InMemoryV2InputRegistry();
	}

	private currentRevision(): number {
		return Math.max(0, ...[...this.eventHistory.values()].flat().map((event) => event.revision));
	}

	private currentEventSeq(): number {
		return Math.max(0, ...[...this.eventHistory.values()].flat().map((event) => event.seq));
	}

	private async handleRequest(state: V2ConnectionState, id: string, command: CommandV2): Promise<void> {
		try {
			const result = command.command === "session/list"
				? await this.service.listSessions()
				: command.command === "model/list"
					? await this.service.listModels()
					: command.command === "session/read" && command.sessionId
						? await (await this.session(state, command.sessionId)).snapshot()
						: undefined;
			if (result === undefined) {
				await this.send(state, { type: "response", id, ok: false, error: { code: "not_implemented", message: "Command not implemented" } });
				return;
			}
			await this.send(state, { type: "response", id, ok: true, result: toProtocolJsonValue(result) });
		} catch (error) {
			await this.send(state, { type: "response", id, ok: false, error: this.protocolError(error) });
		}
	}

	private async session(state: V2ConnectionState, sessionId: string): Promise<PiSessionRuntimeV2> {
		const existing = state.sessions.get(sessionId);
		if (existing) return existing;
		const runtime = await this.service.openSession(sessionId);
		state.sessions.set(sessionId, runtime);
		return runtime;
	}

	private async send(state: V2ConnectionState, message: ServerMessageV2): Promise<boolean> {
		if (state.closed || state.connection.closed) return false;
		try {
			await state.connection.send(encodeServerMessageV2(message, { maxFrameLength: this.maxFrameLength }));
			return true;
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(state);
			return false;
		}
	}

	private async failProtocol(state: V2ConnectionState, code: string, message: string, cause?: unknown): Promise<void> {
		if (state.closed) return;
		if (cause !== undefined) this.reportError(cause);
		clearTimeout(state.handshakeTimeout);
		state.closed = true;
		try {
			await state.connection.close(encodeServerMessageV2({ type: "hello_error", error: { code, message: this.sanitizeMessage(message) } }, { maxFrameLength: this.maxFrameLength }));
		} catch (closeError) {
			this.reportError(closeError);
		}
		await this.disconnect(state);
	}

	private async disconnect(state: V2ConnectionState): Promise<void> {
		clearTimeout(state.handshakeTimeout);
		this.connections.delete(state);
		await Promise.all([...state.sessions.values()].map((runtime) => runtime.dispose().catch((error) => this.reportError(error))));
		state.sessions.clear();
		state.closed = true;
	}

	private async closeConnection(state: V2ConnectionState): Promise<void> {
		if (!state.connection.closed) {
			try {
				await state.connection.close();
			} catch (error) {
				this.reportError(error);
			}
		}
		await this.disconnect(state);
	}

	private protocolError(error: unknown): { code: string; message: string } {
		this.reportError(error);
		return { code: "internal_error", message: "Internal server error" };
	}

	private sanitizeMessage(message: string): string {
		const normalized = message.replace(/[\r\n]+/g, " ");
		return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
	}

	private reportError(error: unknown): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		void this.diagnostics?.record({ kind: "server_error", payload: { message: normalized.message } }).catch(() => {});
		try {
			this.onError?.(normalized);
		} catch {
			return;
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
		for (const operation of stored.operations) this.operations.set(operation.operationId, operation);
		for (const event of [...stored.events].sort((left, right) => left.seq - right.seq)) {
			const history = this.eventHistory.get(event.sessionId) ?? [];
			history.push(event);
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
		await Promise.all(this.listeners.map((listener) => listener.close()));
		await Promise.all(Array.from(this.connections, (state) => this.closeConnection(state)));
		this.started = false;
	}

	private createConnectionState(connection: ByteConnection): V2ConnectionState {
		const state = {
			id: randomUUID(),
			connection,
			decoder: new ClientMessageV2Decoder({ maxFrameLength: this.maxFrameLength }),
			sessions: new Map<string, PiSessionRuntimeV2>(),
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
			for (const message of state.decoder.push(chunk)) this.dispatch(state, message);
		} catch (error) {
			void this.failProtocol(state, "invalid_request", "Invalid protocol message", error);
		}
	}

	private dispatch(state: V2ConnectionState, message: ReturnType<typeof parseClientMessageV2>): void {
		if (!state.ready) {
			if (message.type !== "hello") return void this.failProtocol(state, "invalid_request", "Expected v2 hello");
			if (state.handshake) return void this.failProtocol(state, "invalid_request", "Handshake already in progress");
			state.handshake = this.handshake(state, message).finally(() => {
				state.handshake = undefined;
			});
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
				revision: this.currentRevision(),
				eventSeq: this.currentEventSeq(),
				sessions: await this.service.listSessions(),
				models: await this.service.listModels(),
			};
			if (!(await this.send(state, { type: "hello", version: PROTOCOL_V2_VERSION, connectionId: state.id, snapshot }))) return;
			state.ready = true;
			clearTimeout(state.handshakeTimeout);
			if (message.lastEvent) {
				const history = this.eventHistory.get(message.lastEvent.sessionId) ?? [];
				const events: EventEnvelopeV2[] = [];
				let replayBytes = 0;
				for (const event of history) {
					if (event.seq <= message.lastEvent.eventSeq) continue;
					if (events.length >= MAX_REPLAY_EVENTS)
						return void (await this.failProtocol(state, "invalid_request", "Replay exceeds configured limit"));
					const encoded = encodeServerMessageV2(event, { maxFrameLength: this.maxFrameLength });
					replayBytes += encoded.byteLength;
					if (replayBytes > MAX_REPLAY_BYTES)
						return void (await this.failProtocol(state, "invalid_request", "Replay exceeds configured limit"));
					events.push(event);
				}
				for (const event of events) if (!(await this.send(state, event))) return;
			}
		} catch (error) {
			await this.failProtocol(state, "internal_error", "Internal server error", error);
		}
	}
}
