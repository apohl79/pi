import {
	type ClientDiagnosticManifestV2,
	type ClientMessageV2,
	type CommandV2,
	DEFAULT_MAX_FRAME_LENGTH,
	decodeCbor,
	type EventCursor,
	type EventEnvelopeV2,
	encodeClientMessageV2,
	FrameDecoder,
	type JsonValue,
	type OperationRecordV2,
	PROTOCOL_V2_VERSION,
	parseServerMessageV2,
	type ResponseEnvelopeV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
	type SessionMetadataV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import type { ClientDiagnosticSpool } from "./diagnostics.ts";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface PiClientV2Options {
	readonly transportFactory: ByteTransportFactory;
	readonly maxFrameLength?: number;
	readonly diagnostics?: {
		readonly manifest: ClientDiagnosticManifestV2;
		readonly afterSeq?: number;
		readonly spool?: ClientDiagnosticSpool;
	};
}

export type V2SessionLeaseMode = "control" | "observer";

export interface CreateSessionV2Options {
	readonly id?: string;
	readonly name?: string;
	readonly cwd?: string;
}

export interface PiSessionV2Handle {
	readonly sessionId: string;
	readonly mode: V2SessionLeaseMode;
	read(): Promise<SessionSnapshotV2>;
	relinquishControl(): Promise<void>;
	acquireControl(): Promise<void>;
	detach(): Promise<void>;
	onEvent(listener: (event: EventEnvelopeV2) => void): () => void;
}

type PendingResponse = { resolve: (message: ResponseEnvelopeV2) => void; reject: (error: Error) => void };

/** Minimal transport-neutral v2 client used by remote daemon callers and the TUI adapter. */
export class PiClientV2 {
	private readonly options: PiClientV2Options;
	private decoder: FrameDecoder;
	private readonly pending = new Map<string, PendingResponse>();
	private readonly listeners = new Set<(event: EventEnvelopeV2) => void>();
	private transport?: ByteTransport;
	private connectedValue = false;
	private disposed = false;
	private requestSequence = 0;
	private lastEventCursorValue?: EventCursor;
	private handshake?: { resolve: (snapshot: ServerSnapshotV2) => void; reject: (error: Error) => void };

	constructor(options: PiClientV2Options) {
		this.options = options;
		this.decoder = new FrameDecoder({ maxFrameLength: options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH });
	}

	get connected(): boolean {
		return this.connectedValue;
	}

	get lastEventCursor(): EventCursor | undefined {
		return this.lastEventCursorValue === undefined ? undefined : { ...this.lastEventCursorValue };
	}

	async connect(lastEvent?: EventCursor): Promise<ServerSnapshotV2> {
		if (this.disposed) throw new Error("PiClientV2 is disposed");
		if (this.connectedValue || this.handshake) throw new Error("PiClientV2 is already connecting or connected");
		const effectiveLastEvent = lastEvent ?? this.lastEventCursorValue;
		if (this.options.diagnostics?.spool !== undefined)
			await this.recordDiagnostic({ event: "client.connecting", severity: "info" });
		this.decoder = new FrameDecoder({ maxFrameLength: this.options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH });
		const snapshot = new Promise<ServerSnapshotV2>((resolve, reject) => {
			this.handshake = { resolve, reject };
		});
		const handlers: ByteTransportHandlers = {
			onData: (chunk) => this.receive(chunk),
			onClose: () => this.fail(new Error("PiClientV2 transport closed")),
			onError: (error) => this.fail(error),
		};
		try {
			this.transport = await this.options.transportFactory(handlers);
			const diagnostics = this.options.diagnostics;
			await this.send({
				type: "hello",
				version: PROTOCOL_V2_VERSION,
				...(effectiveLastEvent === undefined ? {} : { lastEvent: effectiveLastEvent }),
				...(diagnostics === undefined
					? {}
					: {
							diagnostics: {
								manifest: diagnostics.manifest,
								...(diagnostics.afterSeq === undefined ? {} : { afterSeq: diagnostics.afterSeq }),
							},
						}),
			});
			const result = await snapshot;
			if (this.options.diagnostics?.spool !== undefined)
				await this.recordDiagnostic({ event: "client.connected", severity: "info" });
			return result;
		} catch (error) {
			if (this.options.diagnostics?.spool !== undefined)
				await this.recordDiagnostic({ event: "client.connect_failed", severity: "error" });
			this.fail(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	disconnect(): void {
		if (!this.transport && !this.handshake && !this.connectedValue) return;
		this.fail(new Error("PiClientV2 disconnected"));
		if (this.options.diagnostics?.spool !== undefined)
			void this.recordDiagnostic({ event: "client.disconnected", severity: "info" });
		this.transport?.close();
		this.transport = undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disconnect();
		this.disposed = true;
	}

	onEvent(listener: (event: EventEnvelopeV2) => void): () => void {
		if (this.disposed) throw new Error("PiClientV2 is disposed");
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(command: CommandV2): Promise<ResponseEnvelopeV2> {
		if (!this.connectedValue || this.disposed) return Promise.reject(new Error("PiClientV2 is not connected"));
		const id = `v2-request-${++this.requestSequence}`;
		const response = new Promise<ResponseEnvelopeV2>((resolve, reject) => this.pending.set(id, { resolve, reject }));
		void this.send({ type: "request", id, request: command }).catch((error: unknown) => {
			const pending = this.pending.get(id);
			this.pending.delete(id);
			pending?.reject(error instanceof Error ? error : new Error(String(error)));
		});
		return response;
	}

	async listSessions(): Promise<readonly SessionMetadataV2[]> {
		const result = commandResult(await this.request({ command: "session/list" }));
		if (!Array.isArray(result.sessions)) throw new Error("Invalid session/list result");
		return result.sessions as SessionMetadataV2[];
	}

	async createSession(options: CreateSessionV2Options = {}): Promise<SessionSnapshotV2> {
		const result = commandResult(
			await this.request({
				command: "session/create",
				...(Object.keys(options).length === 0 ? {} : { payload: { ...options } as Record<string, JsonValue> }),
			}),
		);
		if (typeof result.session !== "object" || result.session === null || Array.isArray(result.session))
			throw new Error("Invalid session/create result");
		return result.session as SessionSnapshotV2;
	}

	async attachSession(sessionId: string, mode: "control" | "observer" = "control"): Promise<void> {
		commandResult(await this.request({ command: "session/attach", sessionId, payload: { mode } }));
	}

	async openSession(sessionId: string, mode: V2SessionLeaseMode = "control"): Promise<PiSessionV2Handle> {
		await this.attachSession(sessionId, mode);
		return new SessionHandle(this, sessionId, mode);
	}

	async readSession(sessionId: string): Promise<SessionSnapshotV2> {
		const result = commandResult(await this.request({ command: "session/read", sessionId }));
		if (typeof result.session !== "object" || result.session === null) throw new Error("Invalid session/read result");
		return result.session as SessionSnapshotV2;
	}

	async readOperation(operationId: string): Promise<OperationRecordV2> {
		const result = commandResult(await this.request({ command: "operation/read", operationId }));
		if (typeof result.operation !== "object" || result.operation === null || Array.isArray(result.operation))
			throw new Error("Invalid operation/read result");
		return result.operation as OperationRecordV2;
	}

	private async send(message: ClientMessageV2): Promise<void> {
		if (!this.transport) throw new Error("PiClientV2 has no transport");
		await this.transport.send(encodeClientMessageV2(message, { maxFrameLength: this.options.maxFrameLength }));
	}

	private async recordDiagnostic(input: Parameters<ClientDiagnosticSpool["append"]>[0]): Promise<void> {
		try {
			await this.options.diagnostics?.spool?.append(input);
		} catch {
			// Local diagnostics are best-effort and must not change protocol behavior.
		}
	}

	private receive(chunk: Uint8Array): void {
		try {
			for (const frame of this.decoder.push(chunk)) this.handle(parseServerMessageV2(decodeCbor(frame)));
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private handle(message: ServerMessageV2): void {
		if (message.type === "hello") {
			this.connectedValue = true;
			this.handshake?.resolve(message.snapshot);
			this.handshake = undefined;
			return;
		}
		if (message.type === "hello_error") {
			this.handshake?.reject(new Error(message.error.message));
			this.handshake = undefined;
			return;
		}
		if (message.type === "event") {
			this.lastEventCursorValue = { sessionId: message.sessionId, eventSeq: message.seq };
			for (const listener of this.listeners) listener(message);
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		pending.resolve(message);
	}

	private fail(error: Error): void {
		this.connectedValue = false;
		this.handshake?.reject(error);
		this.handshake = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

class SessionHandle implements PiSessionV2Handle {
	private leaseMode: V2SessionLeaseMode;
	private detached = false;

	constructor(client: PiClientV2, sessionId: string, mode: V2SessionLeaseMode) {
		this.client = client;
		this.sessionId = sessionId;
		this.leaseMode = mode;
	}

	private readonly client: PiClientV2;
	readonly sessionId: string;

	get mode(): V2SessionLeaseMode {
		return this.leaseMode;
	}

	read(): Promise<SessionSnapshotV2> {
		this.assertAttached();
		return this.client.readSession(this.sessionId);
	}

	async relinquishControl(): Promise<void> {
		this.assertAttached();
		if (this.leaseMode === "observer") return;
		await this.client.attachSession(this.sessionId, "observer");
		this.leaseMode = "observer";
	}

	async acquireControl(): Promise<void> {
		this.assertAttached();
		if (this.leaseMode === "control") return;
		await this.client.attachSession(this.sessionId, "control");
		this.leaseMode = "control";
	}

	async detach(): Promise<void> {
		if (this.detached) return;
		this.detached = true;
		commandResult(await this.client.request({ command: "session/detach", sessionId: this.sessionId }));
	}

	onEvent(listener: (event: EventEnvelopeV2) => void): () => void {
		this.assertAttached();
		return this.client.onEvent((event) => {
			if (event.sessionId === this.sessionId) listener(event);
		});
	}

	private assertAttached(): void {
		if (this.detached) throw new Error(`Session ${this.sessionId} is detached`);
	}
}

function commandResult(response: ResponseEnvelopeV2): Record<string, unknown> {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
		throw new Error("Expected a command result");
	}
	return response.result as Record<string, unknown>;
}
