import {
	type EventEnvelopeV2,
	encodeClientMessageV2,
	encodeServerMessageV2,
	PROTOCOL_V2_VERSION,
	ServerMessageV2Decoder,
} from "@earendil-works/pi-protocol";
import { expect, test, vi } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { InMemoryForensicRecorder } from "../src/diagnostics.ts";
import { InMemoryV2OperationStore } from "../src/operation-store.ts";
import { ProtocolTestClientV2 } from "../src/testing/client.ts";
import { type PiServerServiceV2, type PiSessionRuntimeV2, PiServerV2 } from "../src/v2.ts";

class RecordingConnection implements ByteConnection {
	readonly chunks: Uint8Array[] = [];
	closed = false;
	finalChunk: Uint8Array | undefined;

	async send(chunk: Uint8Array): Promise<void> {
		this.chunks.push(chunk);
	}

	close(finalChunk?: Uint8Array): void {
		this.finalChunk = finalChunk;
		this.closed = true;
	}
}

const service: PiServerServiceV2 = {
	listSessions: async () => [],
	listModels: async () => [],
	openSession: async () => {
		throw new Error("session is not used by this test");
	},
};

const replayService: PiServerServiceV2 = {
	...service,
	listSessions: async () => [{ id: "session-1", createdAt: 0, updatedAt: 0 }],
};

test("stops replay encoding after the byte cap", async () => {
	const oversizedPayload = Array.from({ length: 17 }, () => "x".repeat(1_000_000));
	const unsupportedPayload = Symbol("must not be encoded");
	const events: readonly EventEnvelopeV2[] = [
		{
			type: "event",
			sessionId: "session-1",
			seq: 1,
			revision: 1,
			event: "session_delta",
			payload: oversizedPayload,
		},
		{
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "session_delta",
			payload: unsupportedPayload,
		} as unknown as EventEnvelopeV2,
	];
	const store = new InMemoryV2OperationStore();
	for (const event of events) await store.appendEvent(event);
	const server = new PiServerV2(replayService, {
		listeners: [],
		operationStore: store,
		maxFrameLength: 32 * 1024 * 1024,
	});
	const connection = new RecordingConnection();
	const handler = server.accept(connection);

	handler.onData(
		encodeClientMessageV2({
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			lastEvent: { sessionId: "session-1", eventSeq: 0 },
		}),
	);
	await vi.waitFor(() => expect(connection.closed).toBe(true));

	const decoder = new ServerMessageV2Decoder();
	const messages = decoder.push(connection.chunks[0]!);
	const finalMessages = connection.finalChunk ? decoder.push(connection.finalChunk) : [];
	await server.close();
	expect(messages).toHaveLength(1);
	expect(finalMessages).toEqual([
		{ type: "hello_error", error: { code: "invalid_request", message: "Replay exceeds configured limit" } },
	]);
});

test("validates bounded v2 options", () => {
	expect(() => new PiServerV2(service, { listeners: [], maxFrameLength: 0 })).toThrow(/maxFrameLength/);
	expect(() => new PiServerV2(service, { listeners: [], maxFrameLength: Number.POSITIVE_INFINITY })).toThrow(
		/maxFrameLength/,
	);
	expect(() => new PiServerV2(service, { listeners: [], handshakeTimeoutMs: 2_147_483_648 })).toThrow(
		/handshakeTimeoutMs/,
	);
});

test("authorizes replay sessions against the handshake snapshot", async () => {
	const store = new InMemoryV2OperationStore();
	await store.appendEvent({
		type: "event",
		sessionId: "private",
		seq: 1,
		revision: 1,
		event: "session_delta",
		payload: {},
	});
	const server = new PiServerV2(service, { listeners: [], operationStore: store });
	const connection = new RecordingConnection();
	const handler = server.accept(connection);
	handler.onData(
		encodeClientMessageV2({
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			lastEvent: { sessionId: "private", eventSeq: 0 },
		}),
	);
	await vi.waitFor(() => expect(connection.closed).toBe(true));
	const decoder = new ServerMessageV2Decoder();
	const messages = decoder.push(connection.chunks[0]!);
	const finalMessages = connection.finalChunk ? decoder.push(connection.finalChunk) : [];
	await server.close();
	expect(messages).toHaveLength(1);
	expect(finalMessages).toEqual([
		{ type: "hello_error", error: { code: "invalid_request", message: "Replay session is not available" } },
	]);
});

test("shares concurrent start calls", async () => {
	let resolveStart: (() => void) | undefined;
	const listener = {
		start: () =>
			new Promise<void>((resolve) => {
				resolveStart = resolve;
			}),
		close: async () => {},
	};
	const server = new PiServerV2(service, { listeners: [listener] });
	const first = server.start();
	const second = server.start();
	expect(second).toBe(first);
	resolveStart?.();
	await first;
	await server.close();
});

test("does not open a session absent from the handshake snapshot", async () => {
	const openSession = vi.fn(async () => {
		throw new Error("must not open arbitrary session");
	});
	const server = new PiServerV2({ ...service, openSession }, { listeners: [] });
	const connection = new RecordingConnection();
	const handler = server.accept(connection);
	handler.onData(encodeClientMessageV2({ type: "hello", version: PROTOCOL_V2_VERSION }));
	await vi.waitFor(() => expect(connection.chunks).toHaveLength(1));
	handler.onData(
		encodeClientMessageV2({
			type: "request",
			id: "read-private",
			request: { command: "session/read", sessionId: "private" },
		}),
	);
	await vi.waitFor(() => expect(connection.chunks).toHaveLength(2));
	expect(openSession).not.toHaveBeenCalled();
	await server.close();
});

test("close waits for an in-flight start before closing listeners", async () => {
	let resolveStart: (() => void) | undefined;
	let closed = false;
	const listener = {
		start: () =>
			new Promise<void>((resolve) => {
				resolveStart = resolve;
			}),
		close: async () => {
			closed = true;
		},
	};
	const server = new PiServerV2(service, { listeners: [listener] });
	const started = server.start();
	const closing = server.close();
	await Promise.resolve();
	expect(closed).toBe(false);
	resolveStart?.();
	await closing;
	expect(closed).toBe(true);
	await started;
});

test("connection errors still disconnect when close rejects", async () => {
	const server = new PiServerV2(service, { listeners: [] });
	const connection: ByteConnection = {
		closed: false,
		send: async () => {},
		close: async () => {
			throw new Error("close failed");
		},
	};
	const handler = server.accept(connection);
	const error = new Error("transport failed");
	handler.onError(error);
	await vi.waitFor(() => expect((server as unknown as { connections: Set<unknown> }).connections.size).toBe(0));
	await server.close();
});

test("connection errors are recorded as bounded redacted diagnostics", async () => {
	const recorder = new InMemoryForensicRecorder();
	const errors: Error[] = [];
	const server = new PiServerV2(service, { listeners: [], diagnostics: recorder, onError: (error) => errors.push(error) });
	const connection = new RecordingConnection();
	const handler = server.accept(connection);
	const error = new Error(`token=secret\n${"x".repeat(600)}`);
	handler.onError(error);
	await vi.waitFor(async () => expect(await recorder.read()).toHaveLength(1));
	expect(errors).toEqual([error]);
	expect((await recorder.read())[0]).toMatchObject({ kind: "server_error", payload: { message: "Server error" } });
	await server.close();
});

test("v2 test client rejects hello_error", async () => {
	const client = new ProtocolTestClientV2({
		send: async () => {},
		sendFragmented: async () => {},
		close: async () => {},
	});
	client.receive(
		encodeServerMessageV2({
			type: "hello_error",
			error: { code: "unsupported_version", message: "Unsupported protocol version" },
		}),
	);
	await expect(client.hello()).rejects.toThrow("Unsupported protocol version");
});

test("close reports listener failures after closing connections and runtimes", async () => {
	const dispose = vi.fn(async () => {});
	const runtime: PiSessionRuntimeV2 = {
		snapshot: async () => {
			throw new Error("snapshot is not used by this test");
		},
		accept: async () => ({ operationId: "operation-1", sessionRevision: 0, eventSeq: 0 }),
		run: async () => {},
		dispose,
	};
	const errors: Error[] = [];
	const listener = {
		address: "failing",
		start: async () => {},
		close: async () => {
			throw new Error("listener close failed");
		},
	};
	const server = new PiServerV2(
		{
			listSessions: async () => [{ id: "session-1", createdAt: 0, updatedAt: 0 }],
			listModels: async () => [],
			openSession: async () => runtime,
		},
		{ listeners: [listener], onError: (error) => errors.push(error) },
	);
	const connection = new RecordingConnection();
	const handler = server.accept(connection);
	handler.onData(encodeClientMessageV2({ type: "hello", version: PROTOCOL_V2_VERSION }));
	await vi.waitFor(() => expect(connection.chunks).toHaveLength(1));
	handler.onData(
		encodeClientMessageV2({
			type: "request",
			id: "read",
			request: { command: "session/read", sessionId: "session-1" },
		}),
	);
	await vi.waitFor(() => expect(connection.chunks).toHaveLength(2));

	await server.close();

	expect(connection.closed).toBe(true);
	expect(dispose).toHaveBeenCalledOnce();
	expect(errors).toEqual([new Error("listener close failed")]);
});

test("startup failure closes connections accepted before a listener rejects", async () => {
	const firstConnection = new RecordingConnection();
	const secondConnection = new RecordingConnection();
	const failure = new Error("listener start failed");
	const first = {
		start: async (accept: (connection: ByteConnection) => void) => accept(firstConnection),
		close: async () => {},
	};
	const second = {
		start: async (accept: (connection: ByteConnection) => void) => {
			accept(secondConnection);
			throw failure;
		},
		close: async () => {},
	};
	const server = new PiServerV2(service, { listeners: [first, second] });

	await expect(server.start()).rejects.toBe(failure);

	expect(firstConnection.closed).toBe(true);
	expect(secondConnection.closed).toBe(true);
	await expect(server.start()).rejects.toThrow(/already started or closing/);
});
