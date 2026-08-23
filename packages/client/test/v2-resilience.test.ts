import {
	encodeServerMessageV2,
	PROTOCOL_V2_VERSION,
	type ServerMessageV2,
	type ServerSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import type { ByteTransport, ByteTransportHandlers } from "../src/transport.ts";
import { PiClientV2 } from "../src/v2.ts";

const snapshot: ServerSnapshotV2 = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_V2_VERSION,
	revision: 0,
	eventSeq: 0,
	sessions: [],
	models: [],
};

function transportFixture() {
	const handlers: ByteTransportHandlers[] = [];
	const transports: ByteTransport[] = [];
	return {
		handlers,
		transports,
		factory: async (next: ByteTransportHandlers): Promise<ByteTransport> => {
			handlers.push(next);
			const transport: ByteTransport = { send: async () => {}, close: () => {} };
			transports.push(transport);
			return transport;
		},
		deliver(index: number, message: ServerMessageV2) {
			handlers[index]?.onData(encodeServerMessageV2(message));
		},
	};
}

describe("PiClientV2 resilience", () => {
	test("resets decoder and ignores stale callbacks across reconnects", async () => {
		const fixture = transportFixture();
		const client = new PiClientV2({ transportFactory: fixture.factory });
		const hello = encodeServerMessageV2({
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			connectionId: "connection-1",
			snapshot,
		});

		const first = client.connect();
		await Promise.resolve();
		fixture.handlers[0]?.onData(hello.subarray(0, 2));
		fixture.handlers[0]?.onClose();
		await expect(first).rejects.toThrow("transport closed");

		const second = client.connect();
		await Promise.resolve();
		fixture.deliver(1, { type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-2", snapshot });
		expect(await second).toEqual(snapshot);
		fixture.handlers[0]?.onData(hello);
		expect(client.connected).toBe(true);
		expect(fixture.transports).toHaveLength(2);
		client.disconnect();
	});

	test("contains event listener failures", async () => {
		const fixture = transportFixture();
		const listenerErrors: Error[] = [];
		const client = new PiClientV2({
			transportFactory: fixture.factory,
			onListenerError: (error) => listenerErrors.push(error),
		});
		const connecting = client.connect();
		await Promise.resolve();
		fixture.deliver(0, { type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		client.onEvent(() => {
			throw new Error("consumer failure");
		});
		fixture.deliver(0, {
			type: "event",
			sessionId: "session-1",
			seq: 1,
			revision: 1,
			event: "usage_updated",
			payload: {},
		});
		expect(listenerErrors).toEqual([new Error("consumer failure")]);
		expect(client.connected).toBe(true);
		client.disconnect();
	});

	test("closes a transport that resolves after disconnect", async () => {
		let resolveTransport: ((transport: ByteTransport) => void) | undefined;
		const factory = () =>
			new Promise<ByteTransport>((resolve) => {
				resolveTransport = resolve;
			});
		const client = new PiClientV2({ transportFactory: factory });
		const connecting = client.connect();
		const disconnected = connecting.catch((error: unknown) => error);
		await Promise.resolve();
		const close = vi.fn();
		const transport: ByteTransport = { send: async () => {}, close };
		expect(resolveTransport).toBeDefined();
		client.disconnect();
		resolveTransport?.(transport);

		expect(await disconnected).toEqual(new Error("PiClientV2 transport closed"));
		expect(close).toHaveBeenCalledOnce();
		expect(client.connected).toBe(false);
	});
});
