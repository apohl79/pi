import {
	type ClientMessageV2,
	type CommandV2,
	DEFAULT_MAX_FRAME_LENGTH,
	decodeCbor,
	type EventCursor,
	type EventEnvelopeV2,
	encodeClientMessageV2,
	FrameDecoder,
	isSessionMetadataV2,
	isSessionSnapshotV2,
	PROTOCOL_V2_VERSION,
	parseServerMessageV2,
	type ResponseEnvelopeV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
	type SessionMetadataV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
import type { ListenerErrorHandler } from "./types.ts";

export interface PiClientV2Options {
	readonly transportFactory: ByteTransportFactory;
	readonly maxFrameLength?: number;
	/** Reports subscriber failures without allowing them to corrupt client state. */
	readonly onListenerError?: ListenerErrorHandler;
}

type PendingResponse = { resolve: (message: ResponseEnvelopeV2) => void; reject: (error: Error) => void };

export type V2SessionLeaseMode = "control" | "observer";

export interface PiSessionV2Handle {
	readonly sessionId: string;
	readonly mode: V2SessionLeaseMode;
	read(): Promise<SessionSnapshotV2>;
	relinquishControl(): Promise<void>;
	acquireControl(): Promise<void>;
	detach(): Promise<void>;
	onEvent(listener: (event: EventEnvelopeV2) => void): () => void;
}

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
	private readonly eventCursors = new Map<string, EventCursor>();
	private handshake?: { resolve: (snapshot: ServerSnapshotV2) => void; reject: (error: Error) => void };
	private transportGeneration = 0;

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

	get lastEventCursors(): readonly EventCursor[] {
		return [...this.eventCursors.values()].map((cursor) => ({ ...cursor }));
	}

	async connect(lastEvent?: EventCursor): Promise<ServerSnapshotV2> {
		if (this.disposed) throw new Error("PiClientV2 is disposed");
		if (this.connectedValue || this.handshake) throw new Error("PiClientV2 is already connecting or connected");
		if (lastEvent === undefined && this.eventCursors.size > 1)
			throw new Error("PiClientV2 requires an explicit event cursor when multiple sessions have events");
		const effectiveLastEvent = lastEvent ?? this.lastEventCursorValue;
		this.decoder = new FrameDecoder({ maxFrameLength: this.options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH });
		const snapshot = new Promise<ServerSnapshotV2>((resolve, reject) => {
			this.handshake = { resolve, reject };
		});
		const generation = ++this.transportGeneration;
		const handlers: ByteTransportHandlers = {
			onData: (chunk) => {
				if (generation === this.transportGeneration) this.receive(chunk, generation);
			},
			onClose: () => this.fail(new Error("PiClientV2 transport closed"), generation),
			onError: (error) => this.fail(error, generation),
		};
		try {
			const transport = await this.options.transportFactory(handlers);
			if (generation !== this.transportGeneration || this.disposed) {
				transport.close();
				throw new Error("PiClientV2 transport closed");
			}
			this.transport = transport;
			await this.send({
				type: "hello",
				version: PROTOCOL_V2_VERSION,
				...(effectiveLastEvent === undefined ? {} : { lastEvent: effectiveLastEvent }),
			});
			return await snapshot;
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	disconnect(): void {
		if (!this.transport && !this.handshake && !this.connectedValue) return;
		this.fail(new Error("PiClientV2 disconnected"));
		this.transport?.close();
		this.transport = undefined;
		this.listeners.clear();
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
		const result = this.result(await this.request({ command: "session/list" }));
		if (!Array.isArray(result.sessions) || !result.sessions.every(isSessionMetadataV2))
			throw new Error("Invalid session/list result");
		return result.sessions;
	}

	async attachSession(sessionId: string, mode: "control" | "observer" = "control"): Promise<void> {
		this.result(await this.request({ command: "session/attach", sessionId, payload: { mode } }));
	}

	async openSession(sessionId: string, mode: V2SessionLeaseMode = "control"): Promise<PiSessionV2Handle> {
		await this.attachSession(sessionId, mode);
		return new SessionHandle(this, sessionId, mode);
	}

	async readSession(sessionId: string): Promise<SessionSnapshotV2> {
		const result = this.result(await this.request({ command: "session/read", sessionId }));
		if (!isSessionSnapshotV2(result.session)) throw new Error("Invalid session/read result");
		return result.session;
	}

	private async send(message: ClientMessageV2): Promise<void> {
		if (!this.transport) throw new Error("PiClientV2 has no transport");
		await this.transport.send(encodeClientMessageV2(message, { maxFrameLength: this.options.maxFrameLength }));
	}

	private result(response: ResponseEnvelopeV2): Record<string, unknown> {
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		if (!("result" in response) || typeof response.result !== "object" || response.result === null) throw new Error("Expected a command result");
		return response.result as Record<string, unknown>;
	}

	private receive(chunk: Uint8Array, generation: number): void {
		if (generation !== this.transportGeneration) return;
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
			this.eventCursors.set(message.sessionId, this.lastEventCursorValue);
			for (const listener of this.listeners) {
				try {
					listener(message);
				} catch (error) {
					try {
						this.options.onListenerError?.(error instanceof Error ? error : new Error(String(error)));
					} catch {
						// Listener diagnostics cannot affect client state.
					}
				}
			}
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		pending.resolve(message);
	}

	private fail(error: Error, generation = this.transportGeneration): void {
		if (generation !== this.transportGeneration) return;
		this.connectedValue = false;
		this.transportGeneration += 1;
		const transport = this.transport;
		this.transport = undefined;
		this.decoder = new FrameDecoder({ maxFrameLength: this.options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH });
		this.handshake?.reject(error);
		this.handshake = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		transport?.close();
	}
}

class SessionHandle implements PiSessionV2Handle {
	private leaseMode: V2SessionLeaseMode;
	private detached = false;
	private transition: Promise<void> = Promise.resolve();
	private readonly subscriptions = new Set<() => void>();
	private readonly client: PiClientV2;
	readonly sessionId: string;

	constructor(client: PiClientV2, sessionId: string, mode: V2SessionLeaseMode) {
		this.client = client;
		this.sessionId = sessionId;
		this.leaseMode = mode;
	}

	get mode(): V2SessionLeaseMode {
		return this.leaseMode;
	}

	read(): Promise<SessionSnapshotV2> {
		this.assertAttached();
		return this.client.readSession(this.sessionId);
	}

	relinquishControl(): Promise<void> {
		return this.enqueue(async () => {
			this.assertAttached();
			if (this.leaseMode === "observer") return;
			await this.client.attachSession(this.sessionId, "observer");
			this.leaseMode = "observer";
		});
	}

	acquireControl(): Promise<void> {
		return this.enqueue(async () => {
			this.assertAttached();
			if (this.leaseMode === "control") return;
			await this.client.attachSession(this.sessionId, "control");
			this.leaseMode = "control";
		});
	}

	detach(): Promise<void> {
		return this.enqueue(async () => {
			if (this.detached) return;
			this.client.result(await this.client.request({ command: "session/detach", sessionId: this.sessionId }));
			this.detached = true;
			for (const unsubscribe of this.subscriptions) unsubscribe();
			this.subscriptions.clear();
		});
	}

	onEvent(listener: (event: EventEnvelopeV2) => void): () => void {
		this.assertAttached();
		const unsubscribe = this.client.onEvent((event) => {
			if (event.sessionId === this.sessionId) listener(event);
		});
		this.subscriptions.add(unsubscribe);
		return () => {
			if (this.subscriptions.delete(unsubscribe)) unsubscribe();
		};
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.transition.then(operation, operation);
		this.transition = next.catch(() => {});
		return next;
	}

	private assertAttached(): void {
		if (this.detached) throw new Error(`Session ${this.sessionId} is detached`);
	}
}
