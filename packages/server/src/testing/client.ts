import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
	type ClientDiagnosticManifestV2,
	type ClientMessage,
	type ClientMessageV2,
	type Command,
	type CommandV2,
	decodeCbor,
	type EventCursor,
	encodeClientMessage,
	encodeClientMessageV2,
	FrameDecoder,
	PROTOCOL_V2_VERSION,
	PROTOCOL_VERSION,
	parseServerMessageV2,
	type ResponseEnvelope,
	type ServerMessage,
	ServerMessageDecoder,
	type ServerMessageV2,
} from "@earendil-works/pi-protocol";
import type { ByteConnection, ByteConnectionAcceptor, ByteConnectionHandler } from "../connection.ts";
import { Deferred } from "./service.ts";

interface MessageWaiter {
	predicate: (message: ServerMessage) => boolean;
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
}

export interface WireChannel {
	send(chunk: Uint8Array): Promise<void>;
	sendFragmented(chunk: Uint8Array, splitAt: number): Promise<void>;
	close(): Promise<void>;
}

export class ProtocolTestClient {
	readonly messages: ServerMessage[] = [];
	private readonly channel: WireChannel;
	private readonly decoder = new ServerMessageDecoder();
	private readonly waiters = new Set<MessageWaiter>();
	private readonly closedDeferred = new Deferred<void>();
	private requestSequence = 0;
	private closedValue = false;

	constructor(channel: WireChannel) {
		this.channel = channel;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	hello(version: number = PROTOCOL_VERSION): Promise<ServerMessage> {
		const response = this.next((message) => message.type === "hello" || message.type === "hello_error");
		void this.sendMessage({ type: "hello", version });
		return response;
	}

	async request(command: Command, id = `request-${++this.requestSequence}`): Promise<ResponseEnvelope> {
		const response = this.next(
			(message): message is ResponseEnvelope => message.type === "response" && message.id === id,
		);
		await this.sendMessage({ type: "request", id, request: command });
		return (await response) as ResponseEnvelope;
	}

	sendMessage(message: ClientMessage): Promise<void> {
		return this.channel.send(encodeClientMessage(message));
	}

	sendBytes(chunk: Uint8Array): Promise<void> {
		return this.channel.send(chunk);
	}

	sendFragmentedMessage(message: ClientMessage, splitAt: number): Promise<void> {
		return this.channel.sendFragmented(encodeClientMessage(message), splitAt);
	}

	next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		return this.nextFrom(0, predicate);
	}

	nextFrom(index: number, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.slice(index).find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.closedValue) return Promise.reject(new Error("Wire client is closed"));
		return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
	}

	waitForClose(): Promise<void> {
		return this.closedValue ? Promise.resolve() : this.closedDeferred.promise;
	}

	close(): Promise<void> {
		return this.channel.close();
	}

	receive(chunk: Uint8Array): void {
		try {
			for (const message of this.decoder.push(chunk)) {
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closedDeferred.resolve(undefined);
		this.fail(new Error("Wire connection closed"));
	}

	fail(error: Error): void {
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
	}
}

type MessageWaiterV2 = {
	predicate: (message: ServerMessageV2) => boolean;
	resolve: (message: ServerMessageV2) => void;
	reject: (error: Error) => void;
};

export class ProtocolTestClientV2 {
	readonly messages: ServerMessageV2[] = [];
	private readonly channel: WireChannel;
	private readonly decoder = new FrameDecoder();
	private readonly waiters = new Set<MessageWaiterV2>();
	private readonly closedDeferred = new Deferred<void>();
	private requestSequence = 0;
	private closedValue = false;

	constructor(channel: WireChannel) {
		this.channel = channel;
	}

	hello(
		lastEvent?: EventCursor,
		diagnostics?: { manifest: ClientDiagnosticManifestV2; afterSeq?: number },
	): Promise<ServerMessageV2> {
		const response = this.next((message) => message.type === "hello");
		void this.sendMessage({
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			...(lastEvent === undefined ? {} : { lastEvent }),
			...(diagnostics === undefined ? {} : { diagnostics }),
		});
		return response;
	}

	async request(
		command: CommandV2,
		id = `request-${++this.requestSequence}`,
	): Promise<Extract<ServerMessageV2, { type: "response" }>> {
		const response = this.next(
			(message): message is Extract<ServerMessageV2, { type: "response" }> =>
				message.type === "response" && message.id === id,
		);
		await this.sendMessage({ type: "request", id, request: command });
		return (await response) as Extract<ServerMessageV2, { type: "response" }>;
	}

	sendMessage(message: ClientMessageV2): Promise<void> {
		return this.channel.send(encodeClientMessageV2(message));
	}

	sendFragmentedMessage(message: ClientMessageV2, splitAt: number): Promise<void> {
		return this.channel.sendFragmented(encodeClientMessageV2(message), splitAt);
	}

	next(predicate: (message: ServerMessageV2) => boolean): Promise<ServerMessageV2> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.closedValue) return Promise.reject(new Error("Wire client is closed"));
		return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
	}

	waitForClose(): Promise<void> {
		return this.closedValue ? Promise.resolve() : this.closedDeferred.promise;
	}

	close(): Promise<void> {
		return this.channel.close();
	}

	receive(chunk: Uint8Array): void {
		try {
			for (const frame of this.decoder.push(chunk)) {
				const message = parseServerMessageV2(decodeCbor(frame));
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closedDeferred.resolve(undefined);
		this.fail(new Error("Wire connection closed"));
	}

	fail(error: Error): void {
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
	}
}

/** Connects a protocol v2 test client directly to a server acceptor without a socket or network. */
export function connectInMemoryTestClientV2(acceptor: ByteConnectionAcceptor): ProtocolTestClientV2 {
	let client: ProtocolTestClientV2;
	let handler: ByteConnectionHandler;
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send(chunk) {
			if (closed) throw new Error("In-memory connection is closed");
			client.receive(chunk);
		},
		async close(finalChunk) {
			if (closed) return;
			if (finalChunk !== undefined) client.receive(finalChunk);
			closed = true;
			client.markClosed();
		},
	};
	const channel: WireChannel = {
		async send(chunk) {
			if (closed) throw new Error("In-memory connection is closed");
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			if (splitAt <= 0 || splitAt >= chunk.byteLength) throw new RangeError("splitAt must be inside the frame");
			await this.send(chunk.subarray(0, splitAt));
			await this.send(chunk.subarray(splitAt));
		},
		async close() {
			if (closed) return;
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	};
	client = new ProtocolTestClientV2(channel);
	handler = acceptor(connection);
	return client;
}

export async function connectUnixTestClient(path: string): Promise<ProtocolTestClient> {
	const socket = createConnection(path);
	await once(socket, "connect");
	const client = new ProtocolTestClient({
		send: (chunk) => writeSocket(socket, chunk),
		async sendFragmented(chunk, splitAt) {
			await writeSocket(socket, chunk.subarray(0, splitAt));
			await writeSocket(socket, chunk.subarray(splitAt));
		},
		async close() {
			if (socket.destroyed) return;
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		},
	});
	socket.on("data", (chunk) => {
		client.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	});
	socket.on("error", (error) => client.fail(error));
	socket.once("close", () => client.markClosed());
	return client;
}

export async function connectUnixTestClientV2(path: string): Promise<ProtocolTestClientV2> {
	const socket = createConnection(path);
	await once(socket, "connect");
	const client = new ProtocolTestClientV2({
		send: (chunk) => writeSocket(socket, chunk),
		async sendFragmented(chunk, splitAt) {
			await writeSocket(socket, chunk.subarray(0, splitAt));
			await writeSocket(socket, chunk.subarray(splitAt));
		},
		async close() {
			if (socket.destroyed) return;
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		},
	});
	socket.on("data", (chunk) => client.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
	socket.on("error", (error) => client.fail(error));
	socket.once("close", () => client.markClosed());
	return client;
}

function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		socket.write(chunk, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
