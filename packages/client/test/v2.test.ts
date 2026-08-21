import {
	decodeCbor,
	encodeServerMessageV2,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
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

	test("routes typed session helpers and surfaces failed responses", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;

		const sessions = client.listSessions();
		pair.deliver({ type: "response", id: "v2-request-1", ok: true, result: { sessions: [] } });
		expect(await sessions).toEqual([]);
		const attached = client.attachSession("session-1", "observer");
		pair.deliver({ type: "response", id: "v2-request-2", ok: true, result: { command: "session/attach" } });
		await attached;
		const read = client.readSession("session-1");
		pair.deliver({
			type: "response",
			id: "v2-request-3",
			ok: false,
			error: { code: "not_found", message: "missing" },
		});
		await expect(read).rejects.toThrow("not_found: missing");
	});

	test("keeps session lease transitions and filters session events", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		const handlePromise = client.openSession("session-1");
		pair.deliver({ type: "response", id: "v2-request-1", ok: true, result: { command: "session/attach" } });
		const handle = await handlePromise;
		expect(handle.mode).toBe("control");
		const events: string[] = [];
		handle.onEvent((event) => events.push(event.event));
		pair.deliver({ type: "event", sessionId: "other", seq: 1, revision: 1, event: "usage_updated", payload: {} });
		pair.deliver({ type: "event", sessionId: "session-1", seq: 2, revision: 1, event: "plan_updated", payload: {} });
		expect(events).toEqual(["plan_updated"]);
		const relinquished = handle.relinquishControl();
		pair.deliver({ type: "response", id: "v2-request-2", ok: true, result: { command: "session/attach" } });
		await relinquished;
		expect(handle.mode).toBe("observer");
		const acquired = handle.acquireControl();
		pair.deliver({ type: "response", id: "v2-request-3", ok: true, result: { command: "session/attach" } });
		await acquired;
		expect(handle.mode).toBe("control");
		const detached = handle.detach();
		pair.deliver({ type: "response", id: "v2-request-4", ok: true, result: { command: "session/detach" } });
		await detached;
		expect(() => handle.read()).toThrow("detached");
	});

	test("reconnects with the last acknowledged event cursor", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const first = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await first;
		client.disconnect();
		const second = client.connect({ sessionId: "session-1", eventSeq: 7 });
		await Promise.resolve();
		await Promise.resolve();
		const hello = parseClientMessageV2(decodeCbor(pair.sent[1]!.subarray(4)));
		expect(hello).toMatchObject({ type: "hello", lastEvent: { sessionId: "session-1", eventSeq: 7 } });
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-2", snapshot });
		expect(await second).toEqual(snapshot);
		client.dispose();
	});

	test("retains the latest event cursor for a reconnect without explicit state", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const first = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await first;
		pair.deliver({ type: "event", sessionId: "session-1", seq: 4, revision: 1, event: "usage_updated", payload: {} });
		expect(client.lastEventCursor).toEqual({ sessionId: "session-1", eventSeq: 4 });
		client.disconnect();

		const second = client.connect();
		await Promise.resolve();
		await Promise.resolve();
		const hello = parseClientMessageV2(decodeCbor(pair.sent[1]!.subarray(4)));
		expect(hello).toMatchObject({ type: "hello", lastEvent: { sessionId: "session-1", eventSeq: 4 } });
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-2", snapshot });
		await second;
		client.dispose();
	});
});
