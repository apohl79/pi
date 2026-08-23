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
				message.request.command === "session/read"
					? ({ session: snapshot() } as JsonValue)
					: message.request.command === "plan/update"
						? ({ plan: { version: 1, items: [{ step: "Inspect", status: "in_progress" }] } } as JsonValue)
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
		await session.dispose();
	});

	test("applies server plan updates without requiring a refresh", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "plan_updated",
			payload: { plan: { version: 1, items: [{ step: "Inspect", status: "in_progress" }] } },
		});
		expect(session.snapshot?.plan).toEqual({
			version: 1,
			items: [{ step: "Inspect", status: "in_progress" }],
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 3,
			revision: 3,
			event: "plan_updated",
			payload: { plan: null },
		});
		expect(session.snapshot?.plan).toBeUndefined();
		await session.dispose();
	});

	test("applies server agent updates without requiring a refresh", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "agent_updated",
			payload: {
				agent: {
					id: "agent-1",
					path: "/root/research",
					taskName: "research",
					state: "running",
					model: { provider: "faux", id: "model" },
				},
			},
		});
		expect(session.snapshot?.agents).toEqual([
			{
				id: "agent-1",
				path: "/root/research",
				taskName: "research",
				state: "running",
				model: { provider: "faux", id: "model" },
			},
		]);
		await session.dispose();
	});

	test("answers and cancels structured input through the control lease", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		await session.respondInput("request-1", { answer: "yes" });
		await session.cancelInput("request-2");
		expect(pair.requests.slice(-2).map((request) => request.command)).toEqual([
			"input/request/respond",
			"input/request/cancel",
		]);
		expect(pair.requests.at(-2)?.payload).toEqual({ requestId: "request-1", answers: { answer: "yes" } });
		expect(pair.requests.at(-1)?.payload).toEqual({ requestId: "request-2" });
		await session.dispose();
	});

	test("updates and clears plans through the control lease", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const plan = await session.updatePlan([{ step: "Inspect", status: "in_progress" }]);
		expect(plan).toEqual({ version: 1, items: [{ step: "Inspect", status: "in_progress" }] });
		await session.clearPlan();
		expect(pair.requests.slice(-2).map((request) => request.command)).toEqual(["plan/update", "plan/clear"]);
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
