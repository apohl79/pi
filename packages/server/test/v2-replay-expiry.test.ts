import {
	decodeCbor,
	type EventEnvelopeV2,
	encodeClientMessageV2,
	type ModelMetadata,
	PROTOCOL_V2_VERSION,
	parseServerMessageV2,
	type ServerMessageV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { InMemoryV2OperationStore } from "../src/operation-store.ts";
import { connectInMemoryTestClientV2 } from "../src/testing/index.ts";
import { type PiServerServiceV2, PiServerV2, type PiSessionRuntimeV2 } from "../src/v2.ts";

const model: ModelMetadata = {
	provider: "test",
	id: "small",
	name: "Test Small",
	api: "test-api",
	reasoning: false,
	input: ["text"],
	contextWindow: 16_000,
	maxTokens: 2_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	supportedThinkingLevels: ["off"],
	authenticated: true,
};

const snapshot: SessionSnapshotV2 = {
	id: "session-1",
	nameRevision: 0,
	revision: 300,
	eventSeq: 300,
	phase: "idle",
	model: { provider: model.provider, id: model.id },
	thinkingLevel: "off",
	transcript: [],
	queues: { steer: [], followUp: [] },
	agents: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, pricingState: "known" },
	context: { inputTokens: 0, contextWindow: model.contextWindow, usedPercentage: 0 },
	compactionPolicy: {
		enabled: true,
		contextWindow: model.contextWindow,
		reserveTokens: 1_000,
		keepRecentTokens: 2_000,
		triggerTokens: 15_000,
		source: "global",
	},
	pluginSetHash: "plugins-empty",
	diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 300 },
	persistence: { schemaVersion: 1, recoveryState: "clean" },
	createdAt: 1,
	updatedAt: 1,
};

class Runtime implements PiSessionRuntimeV2 {
	snapshot(): SessionSnapshotV2 {
		return structuredClone(snapshot);
	}

	accept(): never {
		throw new Error("Not used");
	}

	run(): never {
		throw new Error("Not used");
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}
}

class Service implements PiServerServiceV2 {
	listSessions(): Promise<[]> {
		return Promise.resolve([]);
	}

	listModels(): Promise<ModelMetadata[]> {
		return Promise.resolve([model]);
	}

	openSession(sessionId: string): Promise<PiSessionRuntimeV2> {
		if (sessionId !== snapshot.id) return Promise.reject(new Error("Unknown session"));
		return Promise.resolve(new Runtime());
	}
}

describe("PiServerV2 replay expiry", () => {
	test("sends an authoritative session snapshot before the retained event tail", async () => {
		const store = new InMemoryV2OperationStore();
		for (let seq = 1; seq <= 300; seq += 1) {
			const event: EventEnvelopeV2 = {
				type: "event",
				sessionId: snapshot.id,
				seq,
				revision: seq,
				event: "usage_updated",
				payload: { seq },
			};
			await store.appendEvent(event);
		}
		const server = new PiServerV2(new Service(), { listeners: [], operationStore: store });
		await server.start();
		const client = connectInMemoryTestClientV2(server.accept.bind(server));
		await client.hello({ sessionId: snapshot.id, eventSeq: 1 });
		const recovery = await client.next((message) => message.type === "event" && message.event === "session_snapshot");
		expect(recovery).toMatchObject({
			type: "event",
			sessionId: snapshot.id,
			seq: 44,
			event: "session_snapshot",
			payload: { reason: "event_cursor_expired", requestedEventSeq: 1, retainedFrom: 45, snapshot },
		});
		const retainedEvent = await client.next(
			(message) => message.type === "event" && message.event === "usage_updated",
		);
		expect(retainedEvent).toMatchObject({
			seq: 45,
		});
		await client.close();
		await server.close();
	});

	test("replays retained events in sequence order when transport sends complete out of order", async () => {
		const store = new InMemoryV2OperationStore();
		for (const seq of [1, 2, 3]) {
			await store.appendEvent({
				type: "event",
				sessionId: snapshot.id,
				seq,
				revision: seq,
				event: "usage_updated",
				payload: { seq },
			});
		}
		const server = new PiServerV2(new Service(), { listeners: [], operationStore: store });
		await server.start();
		const sent: ServerMessageV2[] = [];
		let resolveEvents: (() => void) | undefined;
		const eventsComplete = new Promise<void>((resolve) => {
			resolveEvents = resolve;
		});
		const connection = {
			closed: false,
			send: async (chunk: Uint8Array) => {
				const message = parseServerMessageV2(decodeCbor(chunk.subarray(4)));
				if (message.type === "event" && message.seq === 2) await new Promise((resolve) => setTimeout(resolve, 20));
				sent.push(message);
				if (sent.filter((item) => item.type === "event").length === 2) resolveEvents?.();
			},
			close: async () => {},
		};
		const handler = server.accept(connection);
		handler.onData(
			encodeClientMessageV2({
				type: "hello",
				version: PROTOCOL_V2_VERSION,
				lastEvent: { sessionId: snapshot.id, eventSeq: 1 },
			}),
		);
		await eventsComplete;
		expect(sent.filter((message) => message.type === "event").map((message) => message.seq)).toEqual([2, 3]);
		await server.close();
	});

	test("serializes concurrent live event delivery per connection", async () => {
		const server = new PiServerV2(new Service(), { listeners: [] });
		const sent: ServerMessageV2[] = [];
		const runtime = new Runtime();
		const state = {
			connection: {
				closed: false,
				send: async (chunk: Uint8Array) => {
					const message = parseServerMessageV2(decodeCbor(chunk.subarray(4)));
					if (message.type === "event" && message.seq === 301)
						await new Promise((resolve) => setTimeout(resolve, 20));
					sent.push(message);
				},
				close: async () => {},
			},
			sessions: new Map([[snapshot.id, runtime]]),
		};
		const internals = server as unknown as {
			connections: Set<typeof state>;
			broadcastEvent: (
				sessionId: string,
				runtime: PiSessionRuntimeV2,
				payload: Record<string, unknown>,
				operationId: string | undefined,
				eventName: EventEnvelopeV2["event"],
			) => Promise<void>;
		};
		internals.connections.add(state);
		await Promise.all([
			internals.broadcastEvent(snapshot.id, runtime, { seq: 1 }, undefined, "usage_updated"),
			internals.broadcastEvent(snapshot.id, runtime, { seq: 2 }, undefined, "usage_updated"),
		]);
		expect(sent.filter((message) => message.type === "event").map((message) => message.seq)).toEqual([301, 302]);
	});
});
