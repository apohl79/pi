import {
	encodeServerMessageV2,
	PROTOCOL_V2_VERSION,
	type ServerMessageV2,
	type ServerSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { ByteTransport, ByteTransportHandlers } from "../src/transport.ts";
import { PiClientV2 } from "../src/v2.ts";

function transportPair() {
	let handlers: ByteTransportHandlers | undefined;
	const sent: Uint8Array[] = [];
	const transport: ByteTransport = {
		send: async (chunk) => {
			sent.push(chunk);
		},
		close: () => {},
	};
	return {
		factory: async (next: ByteTransportHandlers) => {
			handlers = next;
			return transport;
		},
		sent,
		deliver(message: ServerMessageV2) {
			handlers?.onData(encodeServerMessageV2(message));
		},
	};
}

const snapshot: ServerSnapshotV2 = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_V2_VERSION,
	revision: 0,
	eventSeq: 0,
	sessions: [],
	models: [],
};

describe("PiClientV2", () => {
	test("handshakes, correlates requests, and publishes events", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		expect(pair.sent).toHaveLength(1);
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		expect(await connecting).toEqual(snapshot);
		const events: string[] = [];
		client.onEvent((event) => events.push(event.event));
		const response = client.request({ command: "session/list" });
		const requestId = "v2-request-1";
		pair.deliver({ type: "event", sessionId: "session-1", seq: 1, revision: 1, event: "usage_updated", payload: {} });
		pair.deliver({ type: "response", id: requestId, ok: true, result: { sessions: [] } });
		expect(await response).toMatchObject({ ok: true, result: { sessions: [] } });
		expect(events).toEqual(["usage_updated"]);
		client.disconnect();
		expect(client.connected).toBe(false);
	});

	test("resets decoder and ignores stale transport callbacks before reconnect", async () => {
		let handlers: ByteTransportHandlers | undefined;
		const transports: ByteTransport[] = [];
		const factory = async (next: ByteTransportHandlers): Promise<ByteTransport> => {
			handlers = next;
			const transport: ByteTransport = { send: async () => {}, close: () => {} };
			transports.push(transport);
			return transport;
		};
		const client = new PiClientV2({ transportFactory: factory });
		const hello = encodeServerMessageV2({
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			connectionId: "connection-1",
			snapshot,
		});
		const first = client.connect();
		await Promise.resolve();
		handlers?.onData(hello.subarray(0, 2));
		const staleHandlers = handlers;
		staleHandlers?.onClose();
		await expect(first).rejects.toThrow("transport closed");

		const second = client.connect();
		await Promise.resolve();
		handlers?.onData(hello);
		expect(await second).toEqual(snapshot);
		staleHandlers?.onData(hello);
		expect(transports).toHaveLength(2);
		client.disconnect();
	});

	test("contains event listener failures", async () => {
		const pair = transportPair();
		const listenerErrors: Error[] = [];
		const client = new PiClientV2({ transportFactory: pair.factory, onListenerError: (error) => listenerErrors.push(error) });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		client.onEvent(() => {
			throw new Error("consumer failure");
		});
		pair.deliver({ type: "event", sessionId: "session-1", seq: 1, revision: 1, event: "usage_updated", payload: {} });
		expect(listenerErrors).toEqual([new Error("consumer failure")]);
		expect(client.connected).toBe(true);
		client.disconnect();
	});
});
