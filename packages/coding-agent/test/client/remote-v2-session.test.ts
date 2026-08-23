import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import {
	type CommandV2,
	decodeCbor,
	encodeServerMessageV2,
	type JsonValue,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerMessageV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";

function snapshot(overrides: Partial<SessionSnapshotV2> = {}): SessionSnapshotV2 {
	return {
		id: "session-1",
		nameRevision: 0,
		revision: 1,
		eventSeq: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		transcript: [],
		queues: { steer: [], followUp: [] },
		agents: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingState: "known" },
		context: { inputTokens: 0, contextWindow: 16_000, usedPercentage: 0 },
		compactionPolicy: {
			enabled: true,
			contextWindow: 16_000,
			reserveTokens: 1_000,
			keepRecentTokens: 2_000,
			triggerTokens: 15_000,
			source: "global",
		},
		pluginSetHash: "plugins-empty",
		diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 1 },
		persistence: { schemaVersion: 1, recoveryState: "clean" },
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function memoryTransport() {
	let handlers: ByteTransportHandlers | undefined;
	const sent: ServerMessageV2[] = [];
	const requests: CommandV2[] = [];
	const transport: ByteTransport = {
		send: async (chunk) => {
			const message = parseClientMessageV2(decodeCbor(chunk.subarray(4)));
			if (message.type === "hello") {
				handlers?.onData(
					encodeServerMessageV2({
						type: "hello",
						version: PROTOCOL_V2_VERSION,
						connectionId: "connection-1",
						snapshot: {
							serverId: "server-1",
							protocolVersion: 2,
							revision: 1,
							eventSeq: 1,
							sessions: [],
							models: [],
						},
					}),
				);
				return;
			}
			requests.push(message.request);
			const result: JsonValue =
				message.request.command === "session/read" || message.request.command === "session/create"
					? ({ session: snapshot() } as JsonValue)
					: { command: message.request.command };
			const response: ServerMessageV2 =
				message.request.command.startsWith("turn/") ||
				message.request.command.startsWith("session/model") ||
				message.request.command.startsWith("session/thinking")
					? {
							type: "response",
							id: message.id,
							ok: true,
							accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
						}
					: { type: "response", id: message.id, ok: true, result };
			sent.push(response);
			handlers?.onData(encodeServerMessageV2(response));
		},
		close: () => {},
	};
	return {
		factory: async (next: ByteTransportHandlers) => {
			handlers = next;
			return transport;
		},
		sent,
		requests,
		deliver(message: ServerMessageV2) {
			handlers?.onData(encodeServerMessageV2(message));
		},
	};
}

describe("RemoteV2Session", () => {
	test("creates and opens a server-owned session", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.create(client, { name: "new session", cwd: "/workspace" });
		expect(session.id).toBe("session-1");
		expect(session.state.snapshot).toMatchObject({ id: "session-1", phase: "idle" });
		expect(pair.requests.map((request) => request.command)).toEqual([
			"session/create",
			"session/attach",
			"session/read",
		]);
		await session.dispose();
	});

	test("opens, reads authoritative state, and publishes terminal snapshots", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(session.state).toMatchObject({
			lifecycle: { status: "ready" },
			snapshot: { id: "session-1", phase: "idle" },
		});

		await session.setThinking("high");
		const operation = session.submit("hello");
		expect(await operation).toBe("operation-1");
		expect(session.state.lifecycle).toMatchObject({ status: "busy", operationId: "operation-1" });
		const completed = session.waitForOperation("operation-1");
		expect(pair.requests.find((request) => request.command === "session/thinking/set")?.payload).toEqual({
			level: "high",
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 3,
			revision: 3,
			operationId: "operation-1",
			event: "operation_terminal",
			payload: { state: "complete", snapshot: snapshot({ revision: 3, eventSeq: 3, phase: "idle" }) },
		});
		expect(session.state).toMatchObject({ lifecycle: { status: "ready" }, snapshot: { revision: 3 } });
		expect(await completed).toMatchObject({ revision: 3, phase: "idle" });
		await session.dispose();
	});

	test("rejects mutating commands after detach and reports listener failures", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1", {
			onListenerError: (error) => expect(error.message).toBe("listener"),
		});
		session.subscribe(() => {
			throw new Error("listener");
		});
		await session.detach();
		expect(session.state.lifecycle).toEqual({ status: "detached" });
		await expect(session.submit("blocked")).rejects.toThrow("Session is not open");
		await session.dispose();
	});

	test("exposes lease transfer and remote control actions", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(session.mode).toBe("control");
		await session.relinquishControl();
		expect(session.mode).toBe("observer");
		await expect(session.followUp("later")).rejects.toThrow("control lease");
		await session.acquireControl();
		expect(session.mode).toBe("control");
		expect(await session.followUp("later")).toBe("operation-1");
		expect(await session.rollback()).toBe("operation-1");
		await expect(session.rollback(0)).rejects.toThrow("positive integer");
		await session.dispose();
	});
});
