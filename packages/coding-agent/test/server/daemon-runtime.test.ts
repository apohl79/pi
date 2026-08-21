import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { AdapterV2WebService, InMemoryV2AppRegistry, InMemoryV2PluginRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon runtime", () => {
	test("composes the SQLite service, daemon lifecycle, and CLI runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-faux",
			models: [{ id: "coding-agent-daemon-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const output: unknown[] = [];
		let started = false;
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "pi.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: (value) => output.push(value),
			createServer: (_service, options) => ({
				id: "daemon-1",
				addresses: [`unix://${options.path}`],
				start: async () => {
					started = true;
				},
				close: async () => {
					started = false;
				},
			}),
		});
		await runtime.cli.runServer({ command: "server", action: "start" });
		expect(started).toBe(true);
		expect(runtime.daemon.status()).toEqual({
			state: "running",
			serverId: "daemon-1",
			addresses: [`unix://${join(directory, "pi.sock")}`],
		});
		expect(await runtime.service.listSessions()).toEqual([]);
		expect(output).toHaveLength(1);
		await runtime.close();
		expect(started).toBe(false);
	});

	test("runs a production Unix daemon turn with the deterministic faux provider", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-e2e-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-e2e-faux",
			models: [{ id: "coding-agent-daemon-e2e-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("daemon response")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const accepted = await client.request({ command: "turn/start", sessionId, payload: { text: "hello daemon" } });
			expect(accepted).toMatchObject({ ok: true, accepted: { operationId: expect.any(String) } });
			for (let attempt = 0; attempt < 50; attempt++) {
				const snapshot = await client.request({ command: "session/read", sessionId });
				if (snapshot.ok && "result" in snapshot) {
					const session = (
						snapshot.result as unknown as {
							session: {
								transcript: readonly { content?: readonly { type?: string; text?: string }[] }[];
								phase: string;
							};
						}
					).session;
					if (
						session.transcript.some((item) => item.content?.some((content) => content.text === "daemon response"))
					) {
						expect(session.phase).toBe("idle");
						return;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error("Timed out waiting for daemon turn completion");
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("runs server-default print mode through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-print-e2e-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-print-faux",
			models: [{ id: "coding-agent-daemon-print-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("server default response")]);
		const output: string[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			writeText: (value) => output.push(value),
		});
		try {
			await runtime.cli.runPi({
				command: "pi",
				options: { print: true, messages: ["hello"], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
			});
			expect(output).toEqual(["server default response"]);
		} finally {
			await runtime.close();
		}
	});

	test("runs server-default JSON mode through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-json-e2e-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-json-faux",
			models: [{ id: "coding-agent-daemon-json-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("json response")]);
		const output: unknown[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: (value) => output.push(value),
		});
		try {
			await runtime.cli.runPi({
				command: "pi",
				options: { mode: "json", messages: ["hello"], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
			});
			expect(output).toHaveLength(1);
			const snapshot = output[0] as { phase: string; transcript: readonly { role: string }[] };
			expect(snapshot.phase).toBe("idle");
			expect(snapshot.transcript.some((item) => item.role === "assistant")).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	test("runs server-default interactive mode through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-interactive-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-interactive-faux",
			models: [
				{ id: "coding-agent-daemon-interactive-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("interactive response")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			runInteractive: async (session) => {
				const operationId = await session.submit("hello interactive");
				const snapshot = await session.waitForOperation(operationId);
				expect(snapshot.phase).toBe("idle");
				expect(snapshot.transcript.some((item) => item.role === "assistant")).toBe(true);
			},
		});
		try {
			await runtime.cli.runPi({
				command: "pi",
				options: { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] },
			});
		} finally {
			await runtime.close();
		}
	});

	test("exports and verifies a production-daemon diagnostic bundle offline", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-diagnostics-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-diagnostics-faux",
			models: [
				{ id: "coding-agent-daemon-diagnostics-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("diagnostic response")]);
		const output: unknown[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: (value) => output.push(value),
			writeText: () => {},
		});
		const bundlePath = join(directory, "diagnostic-bundle.json");
		try {
			await runtime.cli.runPi({
				command: "pi",
				options: {
					print: true,
					messages: ["capture diagnostics"],
					fileArgs: [],
					unknownFlags: new Map(),
					diagnostics: [],
				},
			});
			await runtime.cli.runDiagnostics({ command: "diagnostics", action: "export", output: bundlePath });
			const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
				events: readonly unknown[];
				capsules?: readonly unknown[];
			};
			expect(bundle.events.length).toBeGreaterThan(0);
			expect(bundle.capsules?.length).toBeGreaterThan(0);
			await runtime.cli.runDiagnostics({ command: "diagnostics", action: "verify", bundle: bundlePath });
			expect(output.at(-1)).toEqual({ valid: true });
		} finally {
			await runtime.close();
		}
	});

	test("runs a server-owned process through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-process-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-process-faux",
			models: [
				{ id: "coding-agent-daemon-process-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const started = await client.request({
				command: "process/start",
				sessionId,
				payload: { command: `${process.execPath} -e "process.stdout.write('process response')"` },
			});
			expect(started).toMatchObject({ ok: true, result: { process: { state: "running" } } });
			if (!started.ok || !("result" in started)) throw new Error("Process start failed");
			const processId = (started.result as { process: { processId: string } }).process.processId;
			const waited = await client.request({ command: "process/wait", sessionId, payload: { processId } });
			expect(waited).toMatchObject({
				ok: true,
				result: { process: { state: "exited", output: "process response" } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("routes configured web requests through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-web-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-web-faux",
			models: [{ id: "coding-agent-daemon-web-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			web: new AdapterV2WebService({
				execute: async () => [
					{ id: "result-1", title: "Configured", source: "faux", retrievedAt: 1, extract: "ok" },
				],
			}),
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			const response = await client.request({
				command: "web",
				sessionId,
				payload: { operation: "search_query", query: "configured" },
			});
			expect(response).toMatchObject({ ok: true, result: { results: [{ id: "result-1", source: "faux" }] } });
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("resolves execution-host files through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-files-"));
		directories.push(directory);
		await writeFile(join(directory, "host-note.txt"), "host content", "utf8");
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-files-faux",
			models: [{ id: "coding-agent-daemon-files-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			const resolved = await client.request({
				command: "filesystem/reference/read",
				sessionId,
				payload: { reference: "host-note.txt" },
			});
			expect(resolved).toMatchObject({
				ok: true,
				result: { file: { path: await realpath(join(directory, "host-note.txt")) } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("shares configured plugin state with the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugins-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugins-faux",
			models: [
				{ id: "coding-agent-daemon-plugins-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const plugins = new InMemoryV2PluginRegistry();
		await plugins.addMarketplace("local", "file:///tmp/local-marketplace");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			pluginRegistry: plugins,
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const response = await client.request({ command: "marketplace/list" });
			expect(response).toMatchObject({ ok: true, result: { marketplaces: [{ name: "local" }] } });
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("shares configured app state with the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-apps-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-apps-faux",
			models: [{ id: "coding-agent-daemon-apps-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const apps = new InMemoryV2AppRegistry({
			apps: [{ id: "local-calendar", name: "Local Calendar", auth: "authenticated", enabled: true }],
		});
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			apps,
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const response = await client.request({ command: "app/list" });
			expect(response).toMatchObject({
				ok: true,
				result: { apps: [{ id: "local-calendar", auth: "authenticated" }] },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("restores completed operations after a production daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-recovery-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-recovery-faux",
			models: [
				{ id: "coding-agent-daemon-recovery-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("recovered response")]);
		const first = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const firstClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		let operationId: string;
		let completed = false;
		try {
			await first.daemon.start();
			await firstClient.connect();
			const created = await firstClient.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await firstClient.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const accepted = await firstClient.request({
				command: "turn/start",
				sessionId,
				payload: { text: "persist this" },
			});
			if (!accepted.ok || !("accepted" in accepted)) throw new Error("Turn acceptance failed");
			operationId = accepted.accepted.operationId;
			for (let attempt = 0; attempt < 50; attempt++) {
				const read = await firstClient.request({ command: "operation/read", operationId });
				const result =
					read.ok && "result" in read ? (read.result as { operation?: { state?: string } } | null) : null;
				if (result?.operation?.state === "complete") {
					completed = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(completed).toBe(true);
		} finally {
			firstClient.dispose();
			await first.close();
		}

		const second = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const secondClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await second.daemon.start();
			await secondClient.connect();
			const restored = await secondClient.request({ command: "operation/read", operationId });
			expect(restored).toMatchObject({ ok: true, result: { operation: { operationId, state: "complete" } } });
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});
});
