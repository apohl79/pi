import {
	type EventEnvelopeV2,
	encodeClientMessageV2,
	PROTOCOL_V2_VERSION,
	ServerMessageV2Decoder,
} from "@earendil-works/pi-protocol";
import { expect, test, vi } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { InMemoryV2OperationStore } from "../src/operation-store.ts";
import { type PiServerServiceV2, PiServerV2 } from "../src/v2.ts";

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
