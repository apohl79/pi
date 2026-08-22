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
				} else if (message.request.command === "session/list") {
					handlers?.onData(
						encodeServerMessageV2({ type: "response", id: message.id, ok: true, result: { sessions: [] } }),
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

	test("passes parsed auth to client creation", async () => {
		const server = clientFactory();
		const createClient = vi.fn(server.create);
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient,
			write: () => {},
		});
		await runtime.runSessions({ command: "sessions", auth: { type: "token", token: "secret-token" } });
		expect(createClient).toHaveBeenCalledWith(
			{ transport: "unix", path: "/tmp/pi.sock" },
			{ type: "token", token: "secret-token" },
		);
		runtime.close();
	});

	test("closes an attached client when the callback fails", async () => {
		const server = clientFactory();
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			onAttach: async () => {
				throw new Error("attach failed");
			},
		});
		await expect(runtime.runAttach({ command: "attach", sessionId: "session-1" })).rejects.toThrow("attach failed");
		runtime.close();
	});
});
