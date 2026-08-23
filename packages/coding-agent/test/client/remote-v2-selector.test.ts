import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import {
	decodeCbor,
	encodeServerMessageV2,
	type JsonValue,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	formatRemoteV2SessionSelector,
	type RemoteV2SessionEntry,
	RemoteV2SessionSelector,
	sessionStatus,
} from "../../src/client/remote-v2-selector.ts";

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

function attachmentClient(current: SessionSnapshotV2): PiClientV2 {
	let handlers: ByteTransportHandlers | undefined;
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
			const result: JsonValue =
				message.request.command === "session/read"
					? ({ session: current } as JsonValue)
					: { command: message.request.command };
			handlers?.onData(encodeServerMessageV2({ type: "response", id: message.id, ok: true, result }));
		},
		close: () => {},
	};
	return new PiClientV2({
		transportFactory: async (next) => {
			handlers = next;
			return transport;
		},
	});
}

describe("sessionStatus", () => {
	test.each([
		["idle", "idle"],
		["turn", "running"],
		["compaction", "running"],
		["awaitingInput", "awaiting-input"],
		["suspended", "suspended"],
		["failed", "failed"],
	] as const)("maps %s phase to %s", (phase, status) => {
		expect(sessionStatus(snapshot({ phase }))).toBe(status);
	});

	test("prioritizes an active goal while the session is idle", () => {
		expect(
			sessionStatus(
				snapshot({
					goal: {
						id: "goal-1",
						objective: "ship",
						status: "active",
						tokensUsed: 0,
						activeTimeSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				}),
			),
		).toBe("goal-active");
	});

	test("composes an observer attachment with a view and shared disposal", async () => {
		const client = attachmentClient(snapshot());
		await client.connect();
		const attachment = await new RemoteV2SessionSelector(client).attachView("session-1");
		expect(attachment.view.render(120).join("\n")).toContain("session-1");
		await attachment.dispose();
		client.dispose();
	});
});

describe("formatRemoteV2SessionSelector", () => {
	test("renders authoritative status labels and bounded overflow", () => {
		const entries = [
			{ id: "idle", status: "idle", sessionName: "Idle task", cwd: "/work" },
			{ id: "running", status: "running" },
			{ id: "input", status: "awaiting-input" },
			{ id: "suspended", status: "suspended" },
			{ id: "goal", status: "goal-active" },
			{ id: "failed", status: "failed" },
		] as unknown as RemoteV2SessionEntry[];

		expect(formatRemoteV2SessionSelector(entries, 5)).toBe(
			"Idle task · idle · /work\nrunning · running\ninput · awaiting-input\nsuspended · suspended\ngoal · goal-active\nSessions +1 more",
		);
	});

	test("rejects an invalid display limit", () => {
		expect(() => formatRemoteV2SessionSelector([], 0)).toThrow("maxEntries must be a positive safe integer");
	});
});
