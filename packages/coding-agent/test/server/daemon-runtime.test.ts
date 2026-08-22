import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalContinuationScheduler } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import {
	AdapterV2WebService,
	InMemoryForensicRecorder,
	InMemoryV2AppRegistry,
	InMemoryV2PluginRegistry,
	InMemoryV2ProcessRegistry,
	JsonlV2ProcessRegistry,
} from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";
import { createRuntimeManifest } from "../../src/server/runtime-manifest.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon runtime", () => {
	test("validates default child-agent limits from daemon options", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-agent-limits-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-agent-limits-faux",
			models: [{ id: "agent-limits-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);

		await expect(
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath: join(directory, "server.sock"),
				agentMaxDepth: 0,
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			}),
		).rejects.toThrow("maxDepth must be a positive integer");
	});

	test("builds runtime identity from injected release metadata", () => {
		expect(
			createRuntimeManifest({
				PI_BUILD_VERSION: "0.84.2-fork.1",
				PI_FORK_COMMIT: "fork-sha",
				PI_UPSTREAM_BASE_COMMIT: "upstream-sha",
				PI_CONFIG_HASH: "config-sha",
			}),
		).toEqual({
			schemaVersion: 1,
			runtime: `node ${process.version}`,
			platform: process.platform,
			arch: process.arch,
			buildVersion: "0.84.2-fork.1",
			forkCommit: "fork-sha",
			upstreamBaseCommit: "upstream-sha",
			configHash: "config-sha",
		});
	});

	test("uses compiled release identity when runtime environment is absent", async () => {
		const manifest = createRuntimeManifest(
			{},
			{
				buildVersion: "0.84.2-fork.1",
				forkCommit: "fork-sha",
				upstreamBaseCommit: "upstream-sha",
				configHash: "config-sha",
			},
		);
		expect(manifest).toMatchObject({
			buildVersion: "0.84.2-fork.1",
			forkCommit: "fork-sha",
			upstreamBaseCommit: "upstream-sha",
			configHash: "config-sha",
		});
	});

	test("ignores blank release environment values when compiled identity exists", () => {
		expect(
			createRuntimeManifest(
				{
					PI_BUILD_VERSION: "  ",
					PI_FORK_COMMIT: "\t",
					PI_UPSTREAM_BASE_COMMIT: "",
					PI_CONFIG_HASH: "\n",
				},
				{
					buildVersion: "compiled-version",
					forkCommit: "compiled-fork",
					upstreamBaseCommit: "compiled-upstream",
					configHash: "compiled-config",
				},
			),
		).toMatchObject({
			buildVersion: "compiled-version",
			forkCommit: "compiled-fork",
			upstreamBaseCommit: "compiled-upstream",
			configHash: "compiled-config",
		});
	});

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
		let runtimeManifest: unknown;
		let started = false;
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "pi.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: (value) => output.push(value),
			createServer: (_service, options) => {
				runtimeManifest = options.runtimeManifest;
				return {
					id: "daemon-1",
					addresses: [`unix://${options.path}`],
					start: async () => {
						started = true;
					},
					close: async () => {
						started = false;
					},
				};
			},
		});
		await runtime.cli.runServer({ command: "server", action: "start" });
		expect(started).toBe(true);
		expect(runtimeManifest).toMatchObject({
			schemaVersion: 1,
			runtime: `node ${process.version}`,
			platform: process.platform,
			arch: process.arch,
		});
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

	test("passes an explicit lifecycle marker path to the configured daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-marker-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-marker-faux",
			models: [
				{ id: "coding-agent-daemon-marker-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const markerPath = join(directory, "custom", "daemon-state.json");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "pi.sock"),
			lifecycleMarkerPath: markerPath,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			createServer: (_service, options) => {
				return {
					id: "daemon-marker",
					addresses: [`unix://${options.path}`],
					start: async () => {},
					close: async () => {},
				};
			},
		});
		await runtime.daemon.start();
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({ state: "running" });
		expect(await readFile(join(directory, "daemon-state.json")).catch(() => undefined)).toBeUndefined();
		await runtime.close();
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
			await runtime.cli.runClient({ command: "client" });
			expect(await readFile(join(directory, "client-diagnostics.jsonl"), "utf8")).toContain("client.connected");
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
						session.phase === "idle" &&
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

	test("persists provider usage through a production daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-usage-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-usage-faux",
			models: [
				{
					id: "coding-agent-daemon-usage-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
					cost: { input: 0, output: 0.25, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			{
				...fauxAssistantMessage("x"),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
			},
		]);
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath: join(directory, "server.sock"),
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const first = await createRuntime();
		const firstClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		let sessionId = "";
		try {
			await first.daemon.start();
			await firstClient.connect();
			const created = await firstClient.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			sessionId = (created.result as { session: { id: string } }).session.id;
			await firstClient.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await firstClient.request({
				command: "goal/create",
				sessionId,
				payload: { objective: "attribute usage" },
			});
			let goalId = "";
			for (let attempt = 0; attempt < 50; attempt++) {
				const goal = await firstClient.request({ command: "goal/read", sessionId });
				if (goal.ok && "result" in goal && (goal.result as { goal?: { id: string } }).goal !== undefined) {
					goalId = (goal.result as { goal: { id: string } }).goal.id;
					break;
				}
				if (attempt === 49) throw new Error("Timed out waiting for goal creation");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await firstClient.request({ command: "turn/start", sessionId, payload: { text: "measure usage" } });
			for (let attempt = 0; attempt < 50; attempt++) {
				const usage = await firstClient.request({ command: "usage/read", payload: { sessionId } });
				if (
					usage.ok &&
					"result" in usage &&
					(usage.result as { aggregate: { responses: number } }).aggregate.responses > 0
				) {
					expect(usage).toMatchObject({
						result: { aggregate: { responses: 1, costUsd: 0, pricingState: "known" } },
					});
					const read = await firstClient.request({ command: "session/read", sessionId });
					if (
						read.ok &&
						"result" in read &&
						(read.result as { session: { phase: string } }).session.phase === "idle"
					)
						break;
				}
				if (attempt === 49) throw new Error("Timed out waiting for usage ledger entry");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const goalUsage = await firstClient.request({ command: "usage/read", payload: { goalId } });
			expect(goalUsage).toMatchObject({ result: { aggregate: { responses: 1 } } });
		} finally {
			firstClient.dispose();
			await first.close();
		}
		const second = await createRuntime();
		const secondClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await second.daemon.start();
			await secondClient.connect();
			const usage = await secondClient.request({ command: "usage/read", payload: { sessionId } });
			expect(usage).toMatchObject({ result: { aggregate: { responses: 1, costUsd: 0, pricingState: "known" } } });
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});

	test("rolls back a durable production daemon conversation and reloads it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rollback-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rollback-faux",
			models: [
				{ id: "coding-agent-daemon-rollback-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath: join(directory, "server.sock"),
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const first = await createRuntime();
		const firstClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		let sessionId = "";
		try {
			await first.daemon.start();
			await firstClient.connect();
			const created = await firstClient.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			sessionId = (created.result as { session: { id: string } }).session.id;
			await firstClient.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await firstClient.request({ command: "session/name/auto/set", sessionId, payload: { enabled: false } });
			const waitForIdle = async () => {
				for (let attempt = 0; attempt < 50; attempt++) {
					const read = await firstClient.request({ command: "session/read", sessionId });
					if (
						read.ok &&
						"result" in read &&
						(read.result as { session: { phase: string } }).session.phase === "idle"
					)
						return;
					if (attempt === 49) throw new Error("Timed out waiting for rollback fixture operation");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			};
			await firstClient.request({ command: "turn/start", sessionId, payload: { text: "first request" } });
			await waitForIdle();
			await firstClient.request({ command: "turn/start", sessionId, payload: { text: "second request" } });
			await waitForIdle();
			await firstClient.request({ command: "turn/rollback", sessionId, payload: { turns: 1 } });
			await waitForIdle();
			const rolledBack = await firstClient.request({ command: "session/read", sessionId });
			expect(rolledBack).toMatchObject({ ok: true, result: { session: { phase: "idle" } } });
			const transcript = (
				rolledBack as unknown as {
					result: { session: { transcript: Array<{ content: Array<{ text?: string }> }> } };
				}
			).result.session.transcript;
			expect(
				transcript
					.flatMap((item) => item.content)
					.map((item) => item.text)
					.filter(Boolean),
			).toEqual(["first request", "first response"]);
		} finally {
			firstClient.dispose();
			await first.close();
		}
		const second = await createRuntime();
		const secondClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await second.daemon.start();
			await secondClient.connect();
			const reloaded = await secondClient.request({ command: "session/read", sessionId });
			expect(reloaded).toMatchObject({ ok: true, result: { session: { phase: "idle" } } });
			const reloadedTranscript = (
				reloaded as unknown as { result: { session: { transcript: Array<{ content: Array<{ text?: string }> }> } } }
			).result.session.transcript;
			expect(
				reloadedTranscript
					.flatMap((item) => item.content)
					.map((item) => item.text)
					.filter(Boolean),
			).toEqual(["first request", "first response"]);
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});

	test("runs a configured goal continuation after a production daemon turn", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-goal-continuation-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-goal-faux",
			models: [{ id: "coding-agent-daemon-goal-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("goal response")]);
		const continuations: string[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			goalContinuation: ({ goals, harness }) =>
				new GoalContinuationScheduler({
					goals,
					waitForIdle: async (callback) => {
						await harness.waitForIdle();
						await callback();
					},
					continueGoal: async (goal) => {
						continuations.push(goal.objective);
					},
					maxContinuations: 1,
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
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await client.request({ command: "goal/create", sessionId, payload: { objective: "continue daemon work" } });
			await client.request({ command: "turn/start", sessionId, payload: { text: "work" } });
			for (let attempt = 0; attempt < 50; attempt++) {
				if (continuations.length > 0) break;
				if (attempt === 49) throw new Error("Timed out waiting for goal continuation");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(continuations).toEqual(["continue daemon work"]);
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("forks a durable session and re-identifies its goal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-session-fork-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "pi-daemon-session-fork-faux",
			models: [{ id: "pi-daemon-session-fork-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
			expect(created.ok).toBe(true);
			const sourceId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId: sourceId, payload: { mode: "control" } });
			await client.request({ command: "goal/create", sessionId: sourceId, payload: { objective: "fork work" } });
			const sourceGoal = await client.request({ command: "goal/read", sessionId: sourceId });
			expect(sourceGoal.ok).toBe(true);
			const sourceGoalId = (sourceGoal as unknown as { result: { goal: { id: string } } }).result.goal.id;
			const forked = await client.request({
				command: "session/fork",
				sessionId: sourceId,
				payload: { scope: "tree" },
			});
			expect(forked.ok).toBe(true);
			const forkedSession = (forked as unknown as { result: { session: { id: string } } }).result.session;
			expect(forkedSession.id).not.toBe(sourceId);
			const forkedGoal = await client.request({ command: "goal/read", sessionId: forkedSession.id });
			expect(forkedGoal).toMatchObject({
				ok: true,
				result: { goal: { id: expect.not.stringMatching(sourceGoalId) } },
			});
			const sessions = await client.request({ command: "session/list" });
			expect(sessions.ok).toBe(true);
			expect(
				(sessions as unknown as { result: { sessions: Array<{ id: string }> } }).result.sessions.map(
					(session) => session.id,
				),
			).toContain(forkedSession.id);
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("records automatic session naming in the production usage ledger", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-session-name-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-session-name-faux",
			models: [
				{ id: "coding-agent-daemon-session-name-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("x"), fauxAssistantMessage("Durable session name")]);
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				fastModel: faux.getModel(),
				socketPath: join(directory, "server.sock"),
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const runtime = await createRuntime();
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await client.request({ command: "turn/start", sessionId, payload: { text: "name this work" } });
			for (let attempt = 0; attempt < 50; attempt++) {
				const read = await client.request({ command: "session/read", sessionId });
				if (
					read.ok &&
					"result" in read &&
					(read.result as { session: { name?: string; phase: string } }).session.name === "Durable session name" &&
					(read.result as { session: { name?: string; phase: string } }).session.phase === "idle"
				)
					break;
				if (attempt === 49) throw new Error("Timed out waiting for automatic session naming");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const usage = await client.request({ command: "usage/read", payload: { sessionId, purpose: "sessionName" } });
			expect(usage).toMatchObject({ result: { aggregate: { responses: 1, pricingState: "known" } } });
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("keeps an explicit name when fast-model generation races it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-session-name-race-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-session-name-race-faux",
			models: [
				{
					id: "coding-agent-daemon-session-name-race-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		let releaseNaming!: () => void;
		const namingReleased = new Promise<void>((resolve) => {
			releaseNaming = resolve;
		});
		let namingStarted!: () => void;
		const namingStartedSignal = new Promise<void>((resolve) => {
			namingStarted = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage("turn response"),
			async () => {
				namingStarted();
				await namingReleased;
				return fauxAssistantMessage("stale generated title");
			},
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			fastModel: faux.getModel(),
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
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const accepted = await client.request({ command: "turn/start", sessionId, payload: { text: "race naming" } });
			expect(accepted).toMatchObject({ ok: true, accepted: { operationId: expect.any(String) } });
			await namingStartedSignal;
			const explicit = await client.request({
				command: "session/name/set",
				sessionId,
				payload: { name: "Manual title" },
			});
			expect(explicit).toMatchObject({ ok: true });
			releaseNaming();
			for (let attempt = 0; attempt < 50; attempt++) {
				const read = await client.request({ command: "session/read", sessionId });
				if (
					read.ok &&
					"result" in read &&
					(read.result as { session: { name?: string; nameSource?: string; phase: string } }).session.name ===
						"Manual title" &&
					(read.result as { session: { name?: string; nameSource?: string; phase: string } }).session.phase ===
						"idle"
				)
					break;
				if (attempt === 49) throw new Error("Timed out waiting for explicit name to win race");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const usage = await client.request({ command: "usage/read", payload: { sessionId, purpose: "sessionName" } });
			expect(usage).toMatchObject({ result: { aggregate: { responses: 1 } } });
		} finally {
			releaseNaming();
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
			clientDiagnosticSpoolPath: join(directory, "client-diagnostics.jsonl"),
			clientInstanceId: "production-client-1",
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
			await runtime.cli.runSessions({ command: "sessions" });
			const sessions = output.at(-1) as readonly { id: string }[];
			const sessionId = sessions[0]!.id;
			await runtime.cli.runDiagnostics({
				command: "diagnostics",
				action: "export",
				sessionId,
				output: bundlePath,
			});
			const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
				events: readonly unknown[];
				capsules?: readonly unknown[];
				runtimeManifest?: { runtime?: string; platform?: string; arch?: string };
				clientDiagnostics?: { manifest?: { clientInstanceId?: string } };
			};
			expect(bundle.events.length).toBeGreaterThan(0);
			expect(bundle.capsules?.length).toBeGreaterThan(0);
			expect(bundle.runtimeManifest).toMatchObject({
				runtime: expect.stringContaining("node "),
				platform: process.platform,
				arch: process.arch,
			});
			expect(bundle.clientDiagnostics).toMatchObject({ manifest: { clientInstanceId: "production-client-1" } });
			expect(await readFile(join(directory, "diagnostic-log.jsonl"), "utf8")).toContain("daemon_starting");
			await runtime.cli.runDiagnostics({ command: "diagnostics", action: "verify", bundle: bundlePath });
			expect(output.at(-1)).toEqual({ valid: true });
		} finally {
			await runtime.close();
		}
	});

	test("exports an inactive session after daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-inactive-diagnostics-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-inactive-diagnostics-faux",
			models: [
				{
					id: "coding-agent-daemon-inactive-diagnostics-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("persisted diagnostic response")]);
		const output: unknown[] = [];
		const options = {
			agentDir: directory,
			cwd: directory,
			clientDiagnosticSpoolPath: join(directory, "client-diagnostics.jsonl"),
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] as string[] },
			write: (value: unknown): void => {
				output.push(value);
			},
			writeText: () => {},
		};
		const first = await createConfiguredCodingAgentDaemonRuntime(options);
		let sessionId: string;
		try {
			await first.cli.runPi({
				command: "pi",
				options: {
					print: true,
					messages: ["persist diagnostics"],
					fileArgs: [],
					unknownFlags: new Map(),
					diagnostics: [],
				},
			});
			await first.cli.runSessions({ command: "sessions" });
			sessionId = (output.at(-1) as readonly { id: string }[])[0]!.id;
		} finally {
			await first.close();
		}
		await writeFile(
			join(directory, "daemon-state.json"),
			JSON.stringify({ schemaVersion: 1, daemonInstanceId: "previous", state: "running", timestamp: 1 }),
		);

		const second = await createConfiguredCodingAgentDaemonRuntime(options);
		const bundlePath = join(directory, "inactive-diagnostic-bundle.json");
		try {
			await second.daemon.start();
			await second.cli.runDiagnostics({ command: "diagnostics", action: "export", sessionId, output: bundlePath });
			const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as { events: readonly unknown[] };
			expect(bundle.events.length).toBeGreaterThan(0);
			await second.cli.runDiagnostics({ command: "diagnostics", action: "verify", bundle: bundlePath });
			expect(output.at(-1)).toEqual({ valid: true });
		} finally {
			await second.close();
		}
	});

	test("exports provider failure evidence after an unclean daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-provider-failure-diagnostics-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-provider-failure-faux",
			models: [{ id: "provider-failure-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("provider failed", { stopReason: "error", errorMessage: "provider failure" }),
		]);
		const output: unknown[] = [];
		const socketPath = join(tmpdir(), "pi-provider-failure.sock");
		const options = {
			agentDir: directory,
			cwd: directory,
			clientDiagnosticSpoolPath: join(directory, "client-diagnostics.jsonl"),
			models,
			model: faux.getModel(),
			socketPath,
			harness: { tools: [], activeToolNames: [] as string[] },
			write: (value: unknown): void => {
				output.push(value);
			},
			writeText: () => {},
		};
		const first = await createConfiguredCodingAgentDaemonRuntime(options);
		let sessionId: string;
		try {
			await first.cli.runPi({
				command: "pi",
				options: {
					print: true,
					messages: ["trigger provider failure"],
					fileArgs: [],
					unknownFlags: new Map(),
					diagnostics: [],
				},
			});
			await first.cli.runSessions({ command: "sessions" });
			sessionId = (output.at(-1) as readonly { id: string }[])[0]!.id;
		} finally {
			await first.close();
		}
		await writeFile(
			join(directory, "daemon-state.json"),
			JSON.stringify({ schemaVersion: 1, daemonInstanceId: "crashed", state: "running", timestamp: 1 }),
		);

		const second = await createConfiguredCodingAgentDaemonRuntime(options);
		const bundlePath = join(directory, "provider-failure-bundle.json");
		try {
			await second.daemon.start();
			await second.cli.runDiagnostics({ command: "diagnostics", action: "export", sessionId, output: bundlePath });
			const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
				events: readonly unknown[];
				manifest: { unavailable?: readonly string[] };
				clientDiagnostics?: { records?: readonly unknown[] };
			};
			const serialized = JSON.stringify(bundle);
			expect(bundle.events.length).toBeGreaterThan(0);
			expect(serialized).toContain("provider failure");
			expect(serialized).toContain("client.connected");
			expect(bundle.clientDiagnostics?.records?.length).toBeGreaterThan(0);
			expect(bundle.manifest.unavailable).toBeUndefined();
			await second.cli.runDiagnostics({ command: "diagnostics", action: "verify", bundle: bundlePath });
			expect(output.at(-1)).toEqual({ valid: true });
		} finally {
			await second.close();
		}
	});

	test("reports corrupted configured blobs through the production doctor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-blob-doctor-"));
		directories.push(directory);
		const digest = createHash("sha256").update("hello").digest("hex");
		const blobDirectory = join(directory, "blobs");
		await mkdir(blobDirectory, { recursive: true });
		await writeFile(join(blobDirectory, `${digest}.blob`), "corrupt");
		await writeFile(
			join(blobDirectory, `${digest}.json`),
			JSON.stringify({ digest, mimeType: "text/plain", size: 5 }),
		);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-blob-doctor-faux",
			models: [
				{ id: "coding-agent-daemon-blob-doctor-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
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
			await runtime.daemon.start();
			await runtime.cli.runDiagnostics({ command: "diagnostics", action: "doctor" });
			const result = output.at(-1) as { checks: Array<{ name: string; ok: boolean }> };
			expect(result.checks.find((check) => check.name === "blobs")).toMatchObject({ ok: false });
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

	test("recovers persisted process metadata before a reconstructed daemon serves", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-process-recovery-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-process-recovery-faux",
			models: [
				{
					id: "coding-agent-daemon-process-recovery-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		const journalPath = join(directory, "processes.jsonl");
		const markerPath = join(directory, "daemon-state.json");
		const prior = new JsonlV2ProcessRegistry(journalPath, new InMemoryV2ProcessRegistry());
		const started = await prior.start({ sessionId: "session-recovery", command: "demo" });
		await writeFile(
			markerPath,
			JSON.stringify({ schemaVersion: 1, daemonInstanceId: "previous", state: "running", timestamp: 1 }),
		);
		const recovered = new JsonlV2ProcessRegistry(journalPath, new InMemoryV2ProcessRegistry());
		const diagnostics = new InMemoryForensicRecorder();
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			lifecycleMarkerPath: markerPath,
			processes: recovered,
			diagnostics,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			createServer: (_service, options) => ({
				id: "daemon-process-recovery",
				addresses: [`unix://${options.path}`],
				start: async () => {},
				close: async () => {},
			}),
		});
		try {
			await runtime.daemon.start();
			expect(await recovered.getSnapshot(started.processId)).toMatchObject({ state: "lost", command: "demo" });
			expect((await diagnostics.read()).find((event) => event.kind === "daemon_unclean_shutdown")).toMatchObject({
				payload: { previousDaemonInstanceId: "previous", lostProcesses: 1 },
			});
		} finally {
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
					{
						id: "result-1",
						title: "Configured",
						source: "faux",
						retrievedAt: 1,
						url: "https://example.test",
						extract: "ok",
					},
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

	test("surfaces suspended harness work after a production daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-suspended-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-suspended-faux",
			models: [
				{ id: "coding-agent-daemon-suspended-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const first = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		let sessionId: string;
		try {
			await first.daemon.start();
			if (!first.service.createSession) throw new Error("Configured service cannot create sessions");
			const created = await first.service.createSession({ cwd: directory });
			sessionId = created.sessionId;
			const metadata = (await first.repository.list()).find((item) => item.id === sessionId);
			if (!metadata) throw new Error("Session metadata was not persisted");
			const session = await first.repository.open(metadata);
			await session.appendRecord({
				type: "operation_started",
				id: "crashed-root-turn",
				lane: "main",
				sourceLeafId: null,
				intent: {
					kind: "run",
					originalPrompt: [
						{ role: "user", content: [{ type: "text", text: "resume after restart" }], timestamp: 1 },
					],
					initialMessages: [],
				},
			});
		} finally {
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
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await second.daemon.start();
			await client.connect();
			const read = await client.request({ command: "session/read", sessionId });
			expect(read).toMatchObject({
				ok: true,
				result: { session: { persistence: { recoveryState: "needsResolution" }, phase: "idle" } },
			});
			faux.setResponses([fauxAssistantMessage("resumed after restart")]);
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const resumed = await client.request({ command: "turn/resume", sessionId });
			expect(resumed).toMatchObject({ ok: true, accepted: { operationId: expect.any(String) } });
			if (!resumed.ok || !("accepted" in resumed)) throw new Error("Resume was not accepted");
			for (let attempt = 0; attempt < 50; attempt++) {
				const snapshot = await client.request({ command: "session/read", sessionId });
				if (
					snapshot.ok &&
					"result" in snapshot &&
					(snapshot.result as { session: { persistence: { recoveryState: string } } }).session.persistence
						.recoveryState === "recovered"
				)
					break;
				if (attempt === 49) throw new Error("Timed out waiting for recovery completion");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			client.dispose();
			await second.close();
		}
	});

	test("restores content-addressed blobs after a production daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-blobs-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-blobs-faux",
			models: [{ id: "coding-agent-daemon-blobs-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath: join(directory, "server.sock"),
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const first = await createRuntime();
		const firstClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		let digest: string;
		try {
			await first.daemon.start();
			await firstClient.connect();
			const put = await firstClient.request({
				command: "blob/put",
				payload: { data: "persistent blob", encoding: "utf8", mimeType: "text/plain" },
			});
			expect(put).toMatchObject({ ok: true, result: { blob: { digest: expect.any(String), size: 15 } } });
			if (!put.ok || !("result" in put)) throw new Error("Blob put failed");
			digest = (put.result as { blob: { digest: string } }).blob.digest;
		} finally {
			firstClient.dispose();
			await first.close();
		}
		const second = await createRuntime();
		const secondClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await second.daemon.start();
			await secondClient.connect();
			const read = await secondClient.request({ command: "blob/read", payload: { digest } });
			expect(read).toMatchObject({ ok: true, result: { digest, encoding: "base64", data: "cGVyc2lzdGVudCBibG9i" } });
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});

	test("bridges structured user input through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-input-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-input-faux",
			models: [{ id: "coding-agent-daemon-input-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [{ id: "choice", prompt: "Choose", options: [{ label: "Yes" }] }],
				}),
			),
			fauxAssistantMessage("input handled"),
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { activeToolNames: ["request_user_input"] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			const sessionId = (created.result as { session: { id: string } }).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const accepted = await client.request({ command: "turn/start", sessionId, payload: { text: "ask me" } });
			expect(accepted).toMatchObject({ ok: true, accepted: { operationId: expect.any(String) } });
			let requestId: string | undefined;
			for (let attempt = 0; attempt < 50; attempt++) {
				const read = await client.request({ command: "session/read", sessionId });
				if (read.ok && "result" in read) {
					const session = (read.result as { session: { queues: { pendingInputRequestId?: string } } }).session;
					requestId = session.queues.pendingInputRequestId;
					if (requestId) break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(requestId).toEqual(expect.any(String));
			if (!requestId) throw new Error("Input request was not created");
			const request = await client.request({ command: "input/request/read", payload: { requestId } });
			expect(request).toMatchObject({ ok: true, result: { request: { status: "pending" } } });
			const response = await client.request({
				command: "input/request/respond",
				payload: { requestId, answers: { choice: "Yes" } },
			});
			expect(response).toMatchObject({ ok: true, result: { request: { status: "responded" } } });
			for (let attempt = 0; attempt < 50; attempt++) {
				const read = await client.request({ command: "session/read", sessionId });
				if (read.ok && "result" in read && (read.result as { session: { phase: string } }).session.phase === "idle")
					break;
				if (attempt === 49) throw new Error("Timed out waiting for structured input turn completion");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("restores a pending structured input request after a production daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-input-restart-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-input-restart-faux",
			models: [
				{
					id: "coding-agent-daemon-input-restart-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [{ id: "confirm", prompt: "Continue?", options: [{ label: "Yes" }] }],
				}),
			),
		]);
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath: join(directory, "server.sock"),
				harness: { activeToolNames: ["request_user_input"] },
				write: () => {},
			});
		const first = await createRuntime();
		const firstClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		let sessionId = "";
		let requestId = "";
		try {
			await first.daemon.start();
			await firstClient.connect();
			const created = await firstClient.request({ command: "session/create", payload: { cwd: directory } });
			if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
			sessionId = (created.result as { session: { id: string } }).session.id;
			await firstClient.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await firstClient.request({ command: "turn/start", sessionId, payload: { text: "ask me" } });
			for (let attempt = 0; attempt < 50; attempt++) {
				const read = await firstClient.request({ command: "session/read", sessionId });
				if (read.ok && "result" in read)
					requestId =
						(read.result as { session: { queues: { pendingInputRequestId?: string } } }).session.queues
							.pendingInputRequestId ?? "";
				if (requestId) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(requestId).toEqual(expect.any(String));
		} finally {
			firstClient.dispose();
			await first.close();
		}

		const second = await createRuntime();
		const secondClient = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await second.daemon.start();
			await secondClient.connect();
			const read = await secondClient.request({ command: "session/read", sessionId });
			expect(read).toMatchObject({
				ok: true,
				result: { session: { queues: { pendingInputRequestId: requestId } } },
			});
			const request = await secondClient.request({ command: "input/request/read", payload: { requestId } });
			expect(request).toMatchObject({ ok: true, result: { request: { status: "pending", id: requestId } } });
		} finally {
			secondClient.dispose();
			await second.close();
		}
	});
});
