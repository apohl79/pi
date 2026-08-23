import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import { ClientDiagnosticSpool } from "@earendil-works/pi-client/diagnostics";
import {
	decodeCbor,
	encodeServerMessageV2,
	type JsonValue,
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

const sessionSnapshot = {
	id: "session-1",
	revision: 1,
	eventSeq: 0,
	phase: "idle",
	model: { provider: "faux", id: "model" },
	thinkingLevel: "medium",
	transcript: [],
	queues: { steer: [], followUp: [] },
	steeringMode: "one-at-a-time",
	followUpMode: "all",
	autoRetryEnabled: false,
	agents: [],
	usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, pricingState: "known" },
	context: { inputTokens: 6, contextWindow: 100, usedPercentage: 6 },
	compactionPolicy: {
		enabled: true,
		contextWindow: 100,
		reserveTokens: 10,
		keepRecentTokens: 20,
		triggerTokens: 90,
		source: "global",
	},
	pluginSetHash: "plugins-empty",
	diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 0 },
	persistence: { schemaVersion: 1, recoveryState: "clean" },
	createdAt: 1,
	updatedAt: 1,
};

function clientFactory(requests?: Array<{ command: string; payload?: unknown }>, clientDiagnostics?: unknown) {
	let handlers: ByteTransportHandlers | undefined;
	const factory = async (next: ByteTransportHandlers): Promise<ByteTransport> => {
		handlers = next;
		return {
			send: async (chunk) => {
				const message = parseClientMessageV2(decodeCbor(chunk.subarray(4)));
				if (message.type === "request") requests?.push(message.request);
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
							result: { session: sessionSnapshot },
						}),
					);
				} else if (message.request.command === "session/read") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { session: sessionSnapshot },
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
				} else if (message.request.command === "model/list") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { models: [{ provider: "faux", id: "model" }] },
						}),
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
				} else if (message.request.command === "diagnostics/export") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								command: "diagnostics/export",
								bundle: {
									manifest: { schemaVersion: 1, unavailable: ["client-diagnostic-spool"] },
									events: [],
									...(clientDiagnostics === undefined
										? {}
										: { clientDiagnostics: clientDiagnostics as JsonValue }),
								},
							},
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
				} else if (message.request.command === "filesystem/reference/resolve") {
					const reference = (message.request.payload as { reference: string }).reference;
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								file: { reference, path: reference, kind: "file", size: 12, mimeType: "text/markdown" },
							},
						}),
					);
				} else if (message.request.command === "filesystem/reference/read") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								file: {
									reference: (message.request.payload as { reference: string }).reference,
									path: (message.request.payload as { reference: string }).reference,
									kind: "file",
									size: 12,
									mimeType: "text/markdown",
								},
								encoding: "base64",
								data: Buffer.from("file context").toString("base64"),
							},
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
				} else if (message.request.command === "turn/compact") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							accepted: { operationId: "operation-compact", sessionRevision: 2, eventSeq: 2 },
						}),
					);
				} else if (
					message.request.command === "session/model/set" ||
					message.request.command === "session/thinking/set" ||
					message.request.command === "session/steering-mode/set" ||
					message.request.command === "session/follow-up-mode/set" ||
					message.request.command === "session/compaction/set" ||
					message.request.command === "session/retry/set"
				) {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							accepted: { operationId: "operation-mode", sessionRevision: 2, eventSeq: 2 },
						}),
					);
				} else if (message.request.command === "blob/put") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: { blob: { digest: "image-digest", mimeType: "image/png", size: 3 } },
						}),
					);
				} else if (message.request.command === "process/start") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								process: {
									processId: "process-1",
									sessionId: "session-1",
									command: "printf hello",
									pty: false,
									state: "running",
									output: "",
									cursor: 0,
									truncated: false,
								},
							},
						}),
					);
				} else if (message.request.command === "process/wait") {
					handlers?.onData(
						encodeServerMessageV2({
							type: "response",
							id: message.id,
							ok: true,
							result: {
								process: {
									processId: "process-1",
									sessionId: "session-1",
									command: "printf hello",
									pty: false,
									state: "exited",
									exitCode: 0,
									output: "hello",
									cursor: 5,
									truncated: false,
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

	test("runs the core RPC prompt contract through the server-owned session", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"prompt-1","type":"prompt","message":"hello"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(output).toContainEqual({ id: "prompt-1", type: "response", command: "prompt", success: true });
		runtime.close();
	});

	test("uploads RPC images to the server blob boundary before prompting", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from([
				`${JSON.stringify({
					id: "image-1",
					type: "prompt",
					message: "inspect",
					images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
				})}\n`,
			]),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toContainEqual({
			command: "blob/put",
			payload: { data: "YWJj", mimeType: "image/png", encoding: "base64" },
		});
		expect(requests.find((request) => request.command === "turn/start")?.payload).toEqual({
			content: [
				{ type: "text", text: "inspect" },
				{ type: "image", digest: "image-digest", mimeType: "image/png" },
			],
		});
		expect(output).toContainEqual({ id: "image-1", type: "response", command: "prompt", success: true });
		runtime.close();
	});

	test("projects RPC session reads from the authoritative v2 snapshot", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from([
				'{"id":"stats-1","type":"get_session_stats"}\n{"id":"messages-1","type":"get_messages"}\n',
			]),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(output).toContainEqual(
			expect.objectContaining({ id: "stats-1", command: "get_session_stats", success: true }),
		);
		expect(output).toContainEqual({
			id: "messages-1",
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [] },
		});
		runtime.close();
	});

	test("serves the legacy thinking-level availability command from the v2 contract", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"thinking-1","type":"get_available_thinking_levels"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(output).toContainEqual({
			id: "thinking-1",
			type: "response",
			command: "get_available_thinking_levels",
			success: true,
			data: { levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
		});
		runtime.close();
	});

	test("maps RPC bash execution to the server-owned process registry", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"bash-1","type":"bash","command":"printf hello"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(output).toContainEqual({
			id: "bash-1",
			type: "response",
			command: "bash",
			success: true,
			data: { output: "hello", exitCode: 0, cancelled: false, truncated: false },
		});
		runtime.close();
	});

	test("maps RPC compact to the server-owned compaction operation", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const serverWithRequests = clientFactory(requests);
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: serverWithRequests.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"compact-1","type":"compact","customInstructions":"keep recent fixes"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toContainEqual({
			command: "turn/compact",
			payload: { customInstructions: "keep recent fixes" },
			sessionId: "session-1",
		});
		expect(output).toContainEqual({ id: "compact-1", type: "response", command: "compact", success: true });
		runtime.close();
	});

	test("maps RPC queue modes to server-owned session settings", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from([
				'{"id":"steer-mode","type":"set_steering_mode","mode":"one-at-a-time"}\n',
				'{"id":"follow-mode","type":"set_follow_up_mode","mode":"all"}\n',
			]),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toContainEqual({
			command: "session/steering-mode/set",
			sessionId: "session-1",
			payload: { mode: "one-at-a-time" },
		});
		expect(requests).toContainEqual({
			command: "session/follow-up-mode/set",
			sessionId: "session-1",
			payload: { mode: "all" },
		});
		expect(output).toContainEqual(expect.objectContaining({ id: "steer-mode", success: true }));
		expect(output).toContainEqual(expect.objectContaining({ id: "follow-mode", success: true }));
		runtime.close();
	});

	test("maps RPC auto-compaction changes to the server-owned policy", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"compact-mode","type":"set_auto_compaction","enabled":false}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toContainEqual({
			command: "session/compaction/set",
			sessionId: "session-1",
			payload: { enabled: false },
		});
		expect(output).toContainEqual(expect.objectContaining({ id: "compact-mode", success: true }));
		runtime.close();
	});

	test("maps RPC auto-retry changes to the server-owned policy", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"retry-mode","type":"set_auto_retry","enabled":true}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(requests).toContainEqual({
			command: "session/retry/set",
			sessionId: "session-1",
			payload: { enabled: true },
		});
		expect(output).toContainEqual(expect.objectContaining({ id: "retry-mode", success: true }));
		runtime.close();
	});

	test("projects retry enablement through the legacy get_state response", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			rpcInput: Readable.from(['{"id":"state-1","type":"get_state"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		await runtime.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(output).toContainEqual(
			expect.objectContaining({
				id: "state-1",
				success: true,
				data: expect.objectContaining({ autoRetryEnabled: false }),
			}),
		);
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

	test("writes the exported bundle rather than the RPC envelope", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-diagnostics-export-"));
		const outputPath = join(directory, "bundle.json");
		const server = clientFactory();
		const spool = new ClientDiagnosticSpool({ path: join(directory, "client.jsonl"), clientInstanceId: "client-1" });
		await spool.append({ event: "client.pre_connect" });
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			diagnosticsSpool: spool,
			write: (value) => output.push(value),
		});
		await runtime.runDiagnostics({
			command: "diagnostics",
			action: "export",
			sessionId: "session-1",
			output: outputPath,
		});
		expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
			manifest: { schemaVersion: 1 },
			events: [],
			clientDiagnostics: { afterSeq: 1, records: [{ event: "client.pre_connect" }] },
		});
		expect(JSON.parse(await readFile(outputPath, "utf8")).manifest.unavailable).toBeUndefined();
		expect(output).toMatchObject([{ command: "diagnostics/export" }]);
		runtime.close();
	});

	test("warns when decrypted diagnostics are written to an owner-only destination", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-diagnostics-decrypt-"));
		const outputPath = join(directory, "bundle.json");
		await writeFile(outputPath, "old", { mode: 0o600 });
		await chmod(outputPath, 0o600);
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: clientFactory().create,
			write: (value) => output.push(value),
		});
		await runtime.runDiagnostics({
			command: "diagnostics",
			action: "export",
			output: outputPath,
			decryptContent: true,
		});
		expect(output[0]).toEqual({
			warning: "Decrypted diagnostic export may contain source code and conversation data; protect the output file.",
		});
		expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ manifest: { schemaVersion: 1 } });
		runtime.close();
	});

	test("rejects decrypted diagnostics on a group/world-accessible destination", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-diagnostics-decrypt-unsafe-"));
		const outputPath = join(directory, "bundle.json");
		await writeFile(outputPath, "keep", { mode: 0o644 });
		await chmod(outputPath, 0o644);
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: clientFactory().create,
			write: () => {},
		});
		await expect(
			runtime.runDiagnostics({
				command: "diagnostics",
				action: "export",
				output: outputPath,
				decryptContent: true,
			}),
		).rejects.toThrow("group/world-accessible");
		expect(await readFile(outputPath, "utf8")).toBe("keep");
		runtime.close();
	});

	test("preserves the server bundle when the client diagnostic spool is unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-diagnostics-spool-failure-"));
		const outputPath = join(directory, "bundle.json");
		const server = clientFactory();
		const spool = {
			read: vi.fn().mockRejectedValue(new Error("client spool unavailable")),
			latestSeq: vi.fn().mockRejectedValue(new Error("client spool unavailable")),
		} as unknown as ClientDiagnosticSpool;
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			diagnosticsSpool: spool,
			write: (value) => output.push(value),
		});
		await runtime.runDiagnostics({
			command: "diagnostics",
			action: "export",
			output: outputPath,
		});
		const bundle = JSON.parse(await readFile(outputPath, "utf8")) as {
			manifest: { unavailable?: readonly string[] };
		};
		expect(bundle.manifest.unavailable).toEqual(["client-diagnostic-spool"]);
		expect(output).toMatchObject([{ command: "diagnostics/export" }]);
		runtime.close();
	});

	test("does not merge a client spool with a mismatched server manifest", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-diagnostics-manifest-mismatch-"));
		const outputPath = join(directory, "bundle.json");
		const spool = new ClientDiagnosticSpool({
			path: join(directory, "client.jsonl"),
			clientInstanceId: "local-client",
		});
		await spool.append({ event: "client.local" });
		const server = clientFactory(undefined, { manifest: { clientInstanceId: "remote-client" }, afterSeq: 0 });
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			diagnosticsSpool: spool,
			write: () => {},
		});
		await runtime.runDiagnostics({ command: "diagnostics", action: "export", output: outputPath });
		const bundle = JSON.parse(await readFile(outputPath, "utf8")) as {
			manifest: { unavailable?: readonly string[] };
			clientDiagnostics?: { records?: readonly unknown[] };
		};
		expect(bundle.manifest.unavailable).toEqual(["client-diagnostic-spool"]);
		expect(bundle.clientDiagnostics?.records).toBeUndefined();
		runtime.close();
	});

	test("verifies a bundle file without connecting to a daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-diagnostics-"));
		const events = [{ seq: 1, kind: "boot" }];
		const eventsSha256 = createHash("sha256").update(JSON.stringify(events)).digest("hex");
		const bundle = {
			manifest: {
				schemaVersion: 1,
				eventCount: 1,
				firstSeq: 1,
				lastSeq: 1,
				eventsSha256,
			},
			events,
		};
		await writeFile(join(directory, "bundle.json"), JSON.stringify(bundle));
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: () => {
				throw new Error("offline verification must not create a client");
			},
			write: (value) => output.push(value),
		});
		await runtime.runDiagnostics({
			command: "diagnostics",
			action: "verify",
			bundle: join(directory, "bundle.json"),
		});
		expect(output).toEqual([{ valid: true }]);
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

	test("routes local file arguments through the remote prompt contract", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-file-"));
		const file = join(directory, "prompt.md");
		await writeFile(file, "client file");
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
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
			options: { print: true, messages: ["answer"], fileArgs: [file], unknownFlags: new Map(), diagnostics: [] },
		});
		expect(output).toEqual(["remote reply"]);
		expect(requests.find((request) => request.command === "turn/start")?.payload).toEqual({
			text: `<file name="${file}">\nfile context\n</file>\nanswer`,
		});
		expect(requests.filter((request) => request.command === "filesystem/reference/resolve")).toHaveLength(1);
		runtime.close();
	});

	test("applies server-default model and thinking options before the prompt", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			writeText: () => {},
		});
		await runtime.runPi({
			command: "pi",
			options: {
				print: true,
				provider: "faux",
				model: "model",
				thinking: "high",
				messages: ["hello"],
				fileArgs: [],
				unknownFlags: new Map(),
				diagnostics: [],
			},
		});
		expect(requests.map((request) => request.command)).toEqual([
			"session/create",
			"session/attach",
			"session/read",
			"model/list",
			"session/model/set",
			"session/thinking/set",
			"turn/start",
			"session/detach",
		]);
		expect(requests[4]?.payload).toEqual({ provider: "faux", id: "model" });
		expect(requests[5]?.payload).toEqual({ level: "high" });
		runtime.close();
	});

	test("returns the authoritative snapshot for JSON mode", async () => {
		const server = clientFactory();
		const output: unknown[] = [];
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: (value) => output.push(value),
		});
		await runtime.runPi({
			command: "pi",
			options: { mode: "json", messages: ["hello"], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
		});
		expect(output).toMatchObject([{ id: "session-1", phase: "idle", revision: 2 }]);
		runtime.close();
	});

	test("hands interactive mode to the injected remote runner", async () => {
		const server = clientFactory();
		const runInteractive = vi.fn(async (session, options) => {
			expect(session.phase).toBe("idle");
			expect(options.messages).toEqual([]);
		});
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			runInteractive,
		});
		await runtime.runPi({
			command: "pi",
			options: { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
		});
		expect(runInteractive).toHaveBeenCalledTimes(1);
		runtime.close();
	});

	test("records interactive render failures in the client diagnostic spool", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-cli-render-failure-"));
		const spool = new ClientDiagnosticSpool({ path: join(directory, "client.jsonl"), clientInstanceId: "client-1" });
		const server = clientFactory();
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			diagnosticsSpool: spool,
			write: () => {},
			runInteractive: async () => {
				throw new Error("render failed");
			},
		});
		await expect(
			runtime.runPi({
				command: "pi",
				options: { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
			}),
		).rejects.toThrow("render failed");
		expect(await spool.read()).toMatchObject([
			{ event: "client.render_failed", severity: "error", fields: { error: "Error" } },
		]);
		runtime.close();
	});

	test("submits interactive initial messages exactly once before attaching the runner", async () => {
		const requests: Array<{ command: string; payload?: unknown }> = [];
		const server = clientFactory(requests);
		const runInteractive = vi.fn(async (session) => {
			expect(session.phase).toBe("idle");
		});
		const runtime = createExperimentalCliRuntime({
			daemon: daemon(),
			defaultConnect: { transport: "unix", path: "/tmp/pi.sock" },
			createClient: server.create,
			write: () => {},
			runInteractive,
		});
		await runtime.runPi({
			command: "pi",
			options: { messages: ["hello"], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
		});
		expect(requests.filter((request) => request.command === "turn/start")).toHaveLength(1);
		expect(runInteractive).toHaveBeenCalledTimes(1);
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
