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
	parseRemoteV2Command,
	REMOTE_V2_SLASH_COMMANDS,
	RemoteV2InteractiveAttachment,
} from "../../src/client/remote-v2-interactive.ts";
import { RemoteV2SessionSelector } from "../../src/client/remote-v2-selector.ts";

function snapshot(): SessionSnapshotV2 {
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
	};
}

function clientWithRequests(): { client: PiClientV2; commands: string[] } {
	let handlers: ByteTransportHandlers | undefined;
	const commands: string[] = [];
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
			commands.push(message.request.command);
			const isOperation =
				message.request.command.startsWith("turn/") ||
				message.request.command === "session/model/set" ||
				message.request.command === "session/thinking/set" ||
				message.request.command.startsWith("goal/");
			const response = isOperation
				? {
						type: "response" as const,
						id: message.id,
						ok: true as const,
						accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
					}
				: {
						type: "response" as const,
						id: message.id,
						ok: true as const,
						result: (message.request.command === "session/read"
							? { session: snapshot() }
							: { command: message.request.command }) as JsonValue,
					};
			handlers?.onData(encodeServerMessageV2(response));
		},
		close: () => {},
	};
	return {
		client: new PiClientV2({
			transportFactory: async (next) => {
				handlers = next;
				return transport;
			},
		}),
		commands,
	};
}

describe("remote v2 interactive command boundary", () => {
	test("parses discoverable commands without changing v1 slash commands", () => {
		expect(REMOTE_V2_SLASH_COMMANDS).toContain("/detach");
		expect(parseRemoteV2Command("/follow-up  continue this")).toEqual({ name: "follow-up", text: "continue this" });
		expect(parseRemoteV2Command("/model faux/model-2")).toEqual({ name: "model", provider: "faux", id: "model-2" });
		expect(parseRemoteV2Command("/rollback")).toEqual({ name: "rollback", turns: 1 });
		expect(parseRemoteV2Command("/thinking high")).toEqual({ name: "thinking", level: "high" });
		expect(parseRemoteV2Command("/goal ship the feature")).toEqual({ name: "goal", objective: "ship the feature" });
		expect(parseRemoteV2Command("/goal-pause")).toEqual({ name: "goal-pause" });
		expect(parseRemoteV2Command('/input request-1 {"choice":"yes"}')).toEqual({
			name: "input",
			requestId: "request-1",
			answers: { choice: "yes" },
		});
		expect(parseRemoteV2Command("/input-cancel request-1")).toEqual({ name: "input-cancel", requestId: "request-1" });
		expect(parseRemoteV2Command("/name Project work")).toEqual({ name: "name", value: "Project work" });
		expect(parseRemoteV2Command("/name --clear")).toEqual({ name: "name", clear: true });
		expect(parseRemoteV2Command("/name --generate")).toEqual({ name: "name", generate: true });
		expect(parseRemoteV2Command("/name-auto off")).toEqual({ name: "name-auto", enabled: false });
		expect(() => parseRemoteV2Command("/rollback 0")).toThrow("positive integer");
		expect(() => parseRemoteV2Command('/input request-1 {"choice":true}')).toThrow("only strings");
	});

	test("dispatches remote actions through the attached controller and shares cleanup", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attachment = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const adapter = new RemoteV2InteractiveAttachment(attachment);
		expect(await adapter.execute("/follow-up continue")).toEqual({ kind: "operation", operationId: "operation-1" });
		expect(await adapter.execute("/release-control")).toEqual({ kind: "control", mode: "observer" });
		await adapter.execute("/take-control");
		expect(await adapter.execute("/thinking high")).toEqual({ kind: "operation", operationId: "operation-1" });
		expect(await adapter.execute("/goal ship the feature")).toEqual({
			kind: "operation",
			operationId: "operation-1",
		});
		expect(await adapter.execute('/input request-1 {"choice":"yes"}')).toEqual({
			kind: "status",
			text: "input answered",
		});
		expect(await adapter.execute("/input-cancel request-1")).toEqual({
			kind: "status",
			text: "input cancelled",
		});
		expect(await adapter.execute("/detach")).toEqual({ kind: "detached" });
		expect(commands).toEqual([
			"session/attach",
			"session/read",
			"turn/followUp",
			"session/attach",
			"session/attach",
			"session/thinking/set",
			"goal/create",
			"input/request/respond",
			"input/request/cancel",
			"session/detach",
		]);
		await adapter.dispose();
		client.dispose();
	});

	test("handles bounded terminal lines through the Component boundary", async () => {
		const { client, commands } = clientWithRequests();
		await client.connect();
		const attachment = await new RemoteV2SessionSelector(client).attachView("session-1", { mode: "control" });
		const adapter = new RemoteV2InteractiveAttachment(attachment);
		adapter.handleInput("h");
		adapter.handleInput("i");
		adapter.handleInput("\u007f");
		adapter.handleInput("ello\n");
		expect(adapter.render(80).at(-1)).toContain("> ");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(commands).toContain("turn/start");
		expect(adapter.render(80).at(-1)).toContain("operation operation-1");
		await adapter.execute("/detach");
		await adapter.dispose();
		client.dispose();
	});
});
