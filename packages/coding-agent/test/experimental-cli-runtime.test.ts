import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import {
	decodeCbor,
	encodeServerMessageV2,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { createExperimentalCliRuntime, type ExperimentalDaemonController } from "../src/cli/experimental/runtime.ts";
import { main } from "../src/main.ts";

const snapshot: ServerSnapshotV2 = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_V2_VERSION,
	revision: 0,
	eventSeq: 0,
	sessions: [],
	models: [],
};

function clientFactory() {
	let handlers: ByteTransportHandlers | undefined;
	const factory = async (next: ByteTransportHandlers): Promise<ByteTransport> => {
		handlers = next;
		return {
			send: async (chunk) => {
				const message = parseClientMessageV2(decodeCbor(chunk.subarray(4)));
				if (message.type === "hello") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "hello",
							version: PROTOCOL_V2_VERSION,
							connectionId: "connection-1",
							snapshot,
						}),
					);
				} else if (message.request.command === "session/create") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { session: { id: "session-1", revision: 1, phase: "idle", transcript: [] } },
						}),
					);
				} else if (message.request.command === "session/read") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { session: { id: "session-1", revision: 1, phase: "idle", transcript: [] } },
						}),
					);
				} else if (message.request.command === "session/detach") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { command: "session/detach" },
						}),
					);
				} else if (message.request.command === "session/list") {
					handlers?.onData(
						encodeServerMessageV2({ type: "response", id: message.id, ok: true, result: { sessions: [] } }),
					);
				} else if (message.request.command === "diagnostics/status") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { command: "diagnostics/status", eventCount: 2 },
						}),
					);
				} else if (message.request.command === "session/attach") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { command: "session/attach" },
						}),
					);
				} else if (message.request.command === "turn/start") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
						}),
					);
					handlers?.onData(
						encodeServerMessageV2({
							type: "event",
							sessionId: "session-1",
							seq: 2,
							revision: 2,
							operationId: "operation-1",
							event: "operation_terminal",
							payload: {
								state: "complete",
								snapshot: {
									id: "session-1",
									revision: 2,
									phase: "idle",
									transcript: [{ role: "assistant", content: [{ type: "text", text: "remote reply" }] }],
								},
							},
						}),
					);
				}
			},
			close: () => {},
		};
	};
	return {
		create: () => new PiClientV2({ transportFactory: factory }),
	};
}

function daemon(): ExperimentalDaemonController {
	return {
		start: vi.fn(async () => ({ state: "running" })),
		status: vi.fn(() => ({ state: "stopped" })),
		stop: vi.fn(async () => ({ state: "stopped" })),
	};
}

describe("experimental CLI runtime", () => {
	test("runs daemon lifecycle and session listing through the injected client", async () => {
		const server = clientFactory();
		const controller = daemon();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: controller,
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: (value) => output.push(value),
		});
		await runtime.runServer({ command: "server", action: "start", socket: "/tmp/pi.sock" });
		expect(controller.start).toHaveBeenCalledWith("/tmp/pi.sock");
		await runtime.runSessions({ command: "sessions" });
		expect(output).toEqual([{ state: "running" }, []]);
		runtime.close();
	});

	test("hands an attached v2 session to the remote UI callback", async () => {
		const server = clientFactory();
		const attached = vi.fn(async (handle) => {
			expect(handle.sessionId).toBe("session-1");
		});
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			onAttach: attached,
		});
		await runtime.runAttach({ command: "attach", sessionId: "session-1" });
		expect(attached).toHaveBeenCalledTimes(1);
		runtime.close();
	});

	test("runs diagnostics through the injected client", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: (value) => output.push(value),
		});
		await runtime.runDiagnostics({ command: "diagnostics", action: "status" });
		expect(output).toEqual([{ command: "diagnostics/status", eventCount: 2 }]);
		runtime.close();
	});

	test("runs print mode through a server-owned remote session", async () => {
		const server = clientFactory();
		const output: string[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			writeText: (value) => output.push(value),
		});
		await runtime.runPi({
			command: "pi",
			options: { print: true, messages: ["hello"], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
		});
		expect(output).toEqual(["remote reply"]);
		runtime.close();
	});

	test("main constructs and closes the runtime for experimental commands", async () => {
		const controller = daemon();
		const server = clientFactory();
		const output: unknown[] = [];
		await main(["server", "status"], {
			experimentalCliRuntimeOptions: {
				daemon: controller,
				defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
				createClient: server.create,
				write: (value) => output.push(value),
			},
		});
		expect(controller.status).toHaveBeenCalledTimes(1);
		expect(output).toEqual([{ state: "stopped" }]);
	});
});
