import {
	type ClientMessageV2,
	type CommandV2,
	DEFAULT_MAX_FRAME_LENGTH,
	decodeCbor,
	type EventEnvelopeV2,
	encodeClientMessageV2,
	FrameDecoder,
	PROTOCOL_V2_VERSION,
	parseServerMessageV2,
	type ResponseEnvelopeV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
	type SessionMetadataV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface PiClientV2Options {
	readonly transportFactory: ByteTransportFactory;
	readonly maxFrameLength?: number;
}

type PendingResponse = { resolve: (message: ResponseEnvelopeV2) => void; reject: (error: Error) => void };

/** Minimal transport-neutral v2 client used by remote daemon callers and the TUI adapter. */
export class PiClientV2 {
	private readonly options: PiClientV2Options;
	private readonly decoder: FrameDecoder;
	private readonly pending = new Map<string, PendingResponse>();
	private readonly listeners = new Set<(event: EventEnvelopeV2) => void>();
	private transport?: ByteTransport;
	private connectedValue = false;
	private disposed = false;
	private requestSequence = 0;
	private handshake?: { resolve: (snapshot: ServerSnapshotV2) => void; reject: (error: Error) => void };

	constructor(options: PiClientV2Options) {
		this.options = options;
		this.decoder = new FrameDecoder({ maxFrameLength: options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH });
	}

	get connected(): boolean {
		return this.connectedValue;
	}

	async connect(): Promise<ServerSnapshotV2> {
		if (this.disposed) throw new Error("PiClientV2 is disposed");
		if (this.connectedValue || this.handshake) throw new Error("PiClientV2 is already connecting or connected");
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
			await this.send({ type: "hello", version: PROTOCOL_V2_VERSION });
			return await snapshot;
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	disconnect(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.fail(new Error("PiClientV2 disconnected"));
		this.transport?.close();
		this.transport = undefined;
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
		if (!Array.isArray(result.sessions)) throw new Error("Invalid session/list result");
		return result.sessions as SessionMetadataV2[];
	}

	async attachSession(sessionId: string, mode: "control" | "observer" = "control"): Promise<void> {
		this.result(await this.request({ command: "session/attach", sessionId, payload: { mode } }));
	}

	async readSession(sessionId: string): Promise<SessionSnapshotV2> {
		const result = this.result(await this.request({ command: "session/read", sessionId }));
		if (typeof result.session !== "object" || result.session === null) throw new Error("Invalid session/read result");
		return result.session as SessionSnapshotV2;
	}

	private async send(message: ClientMessageV2): Promise<void> {
		if (!this.transport) throw new Error("PiClientV2 has no transport");
		await this.transport.send(encodeClientMessageV2(message, { maxFrameLength: this.options.maxFrameLength }));
	}

	private result(response: ResponseEnvelopeV2): Record<string, unknown> {
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
			throw new Error("Expected a command result");
		}
		return response.result as Record<string, unknown>;
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
