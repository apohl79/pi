import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
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
});
