import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeCbor,
	encodeServerMessageV2,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerMessageV2,
	type ServerSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { ClientDiagnosticSpool } from "../src/diagnostics.ts";
import type { ForkSessionV2Options } from "../src/index.ts";
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
		close() {
			handlers?.onClose();
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
	test("exports fork options for typed remote callers", () => {
		const options: ForkSessionV2Options = { name: "review", scope: "branch", position: "at" };
		expect(options).toEqual({ name: "review", scope: "branch", position: "at" });
	});

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

	test("creates a session through the typed v2 helper", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		const created = client.createSession({ name: "demo", cwd: "/workspace" });
		pair.deliver({
			type: "response",
			id: "v2-request-1",
			ok: true,
			result: { session: { id: "session-1", name: "demo", cwd: "/workspace" } },
		});
		expect(await created).toMatchObject({ id: "session-1", name: "demo", cwd: "/workspace" });
	});

	test("reads an operation after reconnect", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		const operation = client.readOperation("operation-1");
		pair.deliver({
			type: "response",
			id: "v2-request-1",
			ok: true,
			result: {
				operation: {
					operationId: "operation-1",
					sessionId: "session-1",
					state: "complete",
					accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 4 },
					terminalSeq: 5,
				},
			},
		});
		expect(await operation).toMatchObject({ operationId: "operation-1", state: "complete", terminalSeq: 5 });
	});

	test("lists models and deletes a session through typed helpers", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		const models = client.listModels();
		pair.deliver({
			type: "response",
			id: "v2-request-1",
			ok: true,
			result: { models: [{ provider: "faux", id: "model" }] },
		});
		expect(await models).toMatchObject([{ provider: "faux", id: "model" }]);
		const deleted = client.deleteSession("session-1");
		pair.deliver({ type: "response", id: "v2-request-2", ok: true, result: { sessionId: "session-1" } });
		await deleted;
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
		pair.deliver({ type: "event", sessionId: "session-1", seq: 3, revision: 2, event: "usage_updated", payload: {} });
		expect(events).toEqual(["plan_updated"]);
	});

	test("commits a session handle detach only after server acknowledgement", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const connecting = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connecting;
		const handlePromise = client.openSession("session-1");
		pair.deliver({ type: "response", id: "v2-request-1", ok: true, result: { command: "session/attach" } });
		const handle = await handlePromise;

		const failedDetach = handle.detach();
		pair.deliver({
			type: "response",
			id: "v2-request-2",
			ok: false,
			error: { code: "busy", message: "still running" },
		});
		await expect(failedDetach).rejects.toThrow("busy: still running");

		const retry = handle.detach();
		pair.deliver({ type: "response", id: "v2-request-3", ok: true, result: { command: "session/detach" } });
		await retry;
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

	test("sends the client diagnostic manifest and local cursor during handshake", async () => {
		const pair = transportPair();
		const client = new PiClientV2({
			transportFactory: pair.factory,
			diagnostics: {
				manifest: {
					clientInstanceId: "client-1",
					runtime: "node v22",
					platform: "linux",
					arch: "x64",
					forkCommit: "fork-sha",
				},
				afterSeq: 4,
			},
		});
		const connection = client.connect();
		await Promise.resolve();
		const hello = parseClientMessageV2(decodeCbor(pair.sent[0]!.subarray(4)));
		expect(hello).toMatchObject({
			diagnostics: { manifest: { clientInstanceId: "client-1", forkCommit: "fork-sha" }, afterSeq: 4 },
		});
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connection;
		client.dispose();
	});

	test("records pre-connect and transport lifecycle evidence in the configured spool", async () => {
		const pair = transportPair();
		const directory = await mkdtemp(join(tmpdir(), "pi-client-v2-"));
		const spool = new ClientDiagnosticSpool({ path: join(directory, "client.jsonl"), clientInstanceId: "client-1" });
		const client = new PiClientV2({
			transportFactory: pair.factory,
			diagnostics: {
				manifest: { clientInstanceId: spool.clientInstanceId, runtime: "node v22", platform: "linux", arch: "x64" },
				spool,
			},
		});
		const connection = client.connect();
		await vi.waitFor(() => expect(pair.sent).toHaveLength(1));
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connection;
		pair.close();
		await vi.waitFor(async () =>
			expect(await spool.read()).toMatchObject([
				{ event: "client.connecting" },
				{ event: "client.connected" },
				{ event: "client.transport_closed", severity: "error", fields: { error: "Error" } },
			]),
		);
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

	test("ignores stale events from the current session without regressing the cursor", async () => {
		const pair = transportPair();
		const client = new PiClientV2({ transportFactory: pair.factory });
		const events: number[] = [];
		client.onEvent((event) => events.push(event.seq));
		const connection = client.connect();
		await Promise.resolve();
		pair.deliver({ type: "hello", version: PROTOCOL_V2_VERSION, connectionId: "connection-1", snapshot });
		await connection;
		pair.deliver({ type: "event", sessionId: "session-1", seq: 4, revision: 1, event: "usage_updated", payload: {} });
		pair.deliver({ type: "event", sessionId: "session-1", seq: 3, revision: 1, event: "usage_updated", payload: {} });
		expect(events).toEqual([4]);
		expect(client.lastEventCursor).toEqual({ sessionId: "session-1", eventSeq: 4 });
		client.dispose();
	});
});
