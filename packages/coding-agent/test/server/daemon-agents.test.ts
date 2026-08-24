import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

interface ChildControl {
	readonly onFirstStart?: () => void;
	readonly waitBeforeFirstResponse?: Promise<void>;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createAgentRuntime(
	directory: string,
	childCompletes = true,
	childPrompts?: string[],
	childControl?: ChildControl,
	roleModel?: { provider: string; id: string },
) {
	const models = createModels();
	const parent = fauxProvider({
		provider: "coding-agent-daemon-parent-faux",
		models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	const child = fauxProvider({
		provider: "coding-agent-daemon-child-faux",
		models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(parent.provider);
	models.setProvider(child.provider);
	parent.setResponses([fauxAssistantMessage("inherited child completed")]);
	child.setResponses(
		childCompletes
			? [
					(context) => {
						childControl?.onFirstStart?.();
						childPrompts?.push(
							JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }),
						);
						return (
							childControl?.waitBeforeFirstResponse?.then(() => fauxAssistantMessage("child completed")) ??
							fauxAssistantMessage("child completed")
						);
					},
					(context) => {
						childPrompts?.push(
							JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }),
						);
						return fauxAssistantMessage("child follow-up completed");
					},
				]
			: [() => new Promise(() => {})],
	);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		...(roleModel === undefined
			? {}
			: {
					agentRoles: {
						reviewer: {
							instructions: "Review the change.",
							model: roleModel,
						},
					},
				}),
		socketPath: join(directory, "server.sock"),
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("coding-agent daemon child agents", () => {
	test("runs nested child agents through the server-owned tool path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-nested-"));
		directories.push(directory);
		const models = createModels();
		const parent = fauxProvider({
			provider: "coding-agent-daemon-nested-parent-faux",
			models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const child = fauxProvider({
			provider: "coding-agent-daemon-nested-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const nested = fauxProvider({
			provider: "coding-agent-daemon-nested-leaf-faux",
			models: [{ id: "leaf-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		for (const provider of [parent, child, nested]) models.setProvider(provider.provider);
		parent.setResponses([
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					taskName: "child",
					taskMessage: "start nested work",
					model: { provider: child.provider.id, id: "child-model" },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent complete"),
		]);
		child.setResponses([
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					taskName: "leaf",
					taskMessage: "finish nested work",
					model: { provider: nested.provider.id, id: "leaf-model" },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child complete"),
		]);
		nested.setResponses([fauxAssistantMessage("leaf complete")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: parent.getModel(),
			socketPath: join(directory, "server.sock"),
			agentMaxDepth: 2,
			harness: { activeToolNames: ["spawn_agent"] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("delegate nested work");
				await session.waitForOperation(operationId);
				let agents: readonly { path: string; state: string }[] = [];
				for (let attempt = 0; attempt < 50; attempt++) {
					agents = await session.listAgents();
					if (agents.length === 2 && agents.every((agent) => agent.state === "complete")) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(agents).toEqual([
					expect.objectContaining({ path: "/root/child", state: "complete" }),
					expect.objectContaining({ path: "/root/child/leaf", state: "complete" }),
				]);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("passes the requested durable transcript context into a forked child", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-context-fork-"));
		directories.push(directory);
		const childPrompts: string[] = [];
		const runtime = await createAgentRuntime(directory, true, childPrompts);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const rootOperation = await session.submit("root context for the child");
				await session.waitForOperation(rootOperation);
				const child = await session.spawnAgent("forked", "continue from the root context", {
					forkTurns: 1,
					model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
				});
				await session.waitAgent(child.id);
				for (let attempt = 0; attempt < 50 && childPrompts.length === 0; attempt++)
					await new Promise((resolve) => setTimeout(resolve, 10));
				expect(
					childPrompts.some((prompt) => prompt.includes("[forked context]") && prompt.includes("root context")),
				).toBe(true);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("runs an explicitly selected child model through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-"));
		directories.push(directory);
		const runtime = await createAgentRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: {
					taskName: "specialist",
					taskMessage: "inspect the image workflow",
					model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
				},
			});
			expect(spawned).toMatchObject({
				ok: true,
				result: {
					agent: {
						path: "/root/specialist",
						state: "running",
						model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
						startedAt: expect.any(Number),
						usage: { input: expect.any(Number), output: expect.any(Number) },
					},
				},
			});
			const agentId = (spawned as unknown as { result: { agent: { id: string } } }).result.agent.id;
			const waited = await client.request({ command: "agent/wait", payload: { agentId } });
			expect(waited).toMatchObject({
				ok: true,
				result: {
					agent: {
						id: agentId,
						state: "complete",
						model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
						usage: { input: expect.any(Number), output: expect.any(Number) },
					},
				},
			});
			const listed = await client.request({ command: "agent/list", sessionId });
			expect(listed).toMatchObject({
				ok: true,
				result: {
					agents: [{ id: agentId, path: "/root/specialist", state: "complete", startedAt: expect.any(Number) }],
				},
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("inherits the parent provider and model when a child override is omitted", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-inherit-"));
		directories.push(directory);
		const runtime = await createAgentRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: { taskName: "inherited", taskMessage: "use the parent model" },
			});
			expect(spawned).toMatchObject({
				ok: true,
				result: {
					agent: {
						path: "/root/inherited",
						model: { provider: "coding-agent-daemon-parent-faux", id: "parent-model" },
					},
				},
			});
			const agentId = (spawned as unknown as { result: { agent: { id: string } } }).result.agent.id;
			expect(await client.request({ command: "agent/wait", payload: { agentId } })).toMatchObject({
				ok: true,
				result: {
					agent: { id: agentId, state: "complete", model: { provider: "coding-agent-daemon-parent-faux" } },
				},
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("applies a role model pin when the child model is inherited", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-role-model-"));
		directories.push(directory);
		const childPrompts: string[] = [];
		const runtime = await createAgentRuntime(directory, true, childPrompts, undefined, {
			provider: "coding-agent-daemon-child-faux",
			id: "child-model",
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: { taskName: "reviewer", taskMessage: "review this", role: "reviewer" },
			});
			expect(spawned).toMatchObject({
				ok: true,
				result: { agent: { model: { provider: "coding-agent-daemon-child-faux", id: "child-model" } } },
			});
			const agentId = (spawned as unknown as { result: { agent: { id: string } } }).result.agent.id;
			await client.request({ command: "agent/wait", payload: { agentId } });
			expect(childPrompts.some((prompt) => prompt.includes("Review the change."))).toBe(true);
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("normalizes an explicit parent model to inheritance before applying a role pin", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-role-normalization-"));
		directories.push(directory);
		const runtime = await createAgentRuntime(directory, true, undefined, undefined, {
			provider: "coding-agent-daemon-child-faux",
			id: "child-model",
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({
				command: "session/create",
				payload: { cwd: directory },
			});
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: {
					taskName: "reviewer",
					taskMessage: "review this",
					role: "reviewer",
					model: { provider: "coding-agent-daemon-parent-faux", id: "parent-model" },
				},
			});
			expect(spawned).toMatchObject({
				ok: true,
				result: { agent: { model: { provider: "coding-agent-daemon-child-faux", id: "child-model" } } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("normalizes alias-equivalent child models from the model-facing tool path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-alias-tool-"));
		directories.push(directory);
		const models = createModels();
		const parent = fauxProvider({
			provider: "coding-agent-daemon-alias-parent-faux",
			models: [
				{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "parent-model-20250101", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		const child = fauxProvider({
			provider: "coding-agent-daemon-alias-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(parent.provider);
		models.setProvider(child.provider);
		parent.setResponses([
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					taskName: "alias-child",
					taskMessage: "use the role model",
					role: "reviewer",
					model: { provider: parent.provider.id, id: "parent-model-20250101" },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent complete"),
		]);
		child.setResponses([fauxAssistantMessage("child complete")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: parent.getModel("parent-model")!,
			agentRoles: { reviewer: { model: { provider: child.provider.id, id: "child-model" } } },
			socketPath: join(directory, "server.sock"),
			harness: { activeToolNames: ["spawn_agent"] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("delegate with alias");
				await session.waitForOperation(operationId);
				const agents = await session.listAgents();
				expect(agents).toEqual([
					expect.objectContaining({ model: { provider: child.provider.id, id: "child-model" } }),
				]);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("keeps a running child alive when the parent turn completes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-parent-complete-"));
		directories.push(directory);
		const runtime = await createAgentRuntime(directory, false);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		let session: RemoteV2Session | undefined;
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			session = await RemoteV2Session.open(client, sessionId);
			const child = await session.spawnAgent("long-lived", "keep working", {
				model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
			});
			const parentOperation = await session.submit("finish the parent turn");
			await session.waitForOperation(parentOperation);
			expect((await session.listAgents()).find((agent) => agent.id === child.id)?.state).toBe("running");
			expect((await session.interruptAgent(child.id)).state).toBe("interrupted");
		} finally {
			await session?.dispose();
			client.dispose();
			await runtime.close();
		}
	});

	test("delivers a server message into the child follow-up transcript", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-message-"));
		directories.push(directory);
		const childPrompts: string[] = [];
		const runtime = await createAgentRuntime(directory, true, childPrompts);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: {
					taskName: "messaged",
					taskMessage: "complete the first task",
					model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
				},
			});
			const agentId = (spawned as unknown as { result: { agent: { id: string } } }).result.agent.id;
			await client.request({ command: "agent/wait", payload: { agentId } });
			await client.request({ command: "agent/message", payload: { agentId, message: "urgent context" } });
			await client.request({ command: "agent/followUp", payload: { agentId, message: "continue the task" } });
			await client.request({ command: "agent/wait", payload: { agentId } });
			expect(childPrompts.some((prompt) => prompt.includes("urgent context"))).toBe(true);
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("queues a server message for an active child follow-up", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-active-message-"));
		directories.push(directory);
		const childPrompts: string[] = [];
		const firstStarted = createDeferred();
		const releaseFirst = createDeferred();
		const runtime = await createAgentRuntime(directory, true, childPrompts, {
			onFirstStart: firstStarted.resolve,
			waitBeforeFirstResponse: releaseFirst.promise,
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: {
					taskName: "active-messaged",
					taskMessage: "complete the first task",
					model: { provider: "coding-agent-daemon-child-faux", id: "child-model" },
				},
			});
			const agentId = (spawned as unknown as { result: { agent: { id: string } } }).result.agent.id;
			await firstStarted.promise;
			await client.request({ command: "agent/message", payload: { agentId, message: "active urgent context" } });
			await client.request({ command: "agent/followUp", payload: { agentId, message: "continue the active task" } });
			releaseFirst.resolve();
			await client.request({ command: "agent/wait", payload: { agentId } });
			await client.request({ command: "agent/wait", payload: { agentId } });
			expect(childPrompts).toEqual(expect.arrayContaining([expect.stringContaining("active urgent context")]));
		} finally {
			releaseFirst.resolve();
			client.dispose();
			await runtime.close();
		}
	});

	test("resolves root and child models independently across a root model switch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agents-model-switch-"));
		directories.push(directory);
		const models = createModels();
		const root = fauxProvider({
			provider: "coding-agent-daemon-root-models-faux",
			models: [
				{ id: "root-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "switched-root-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		const child = fauxProvider({
			provider: "coding-agent-daemon-resolved-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(root.provider);
		models.setProvider(child.provider);
		const requestedModels: string[] = [];
		root.setResponses([
			(_context, _options, _state, model) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return fauxAssistantMessage("root before switch");
			},
			(_context, _options, _state, model) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return fauxAssistantMessage("root after switch");
			},
		]);
		child.setResponses([
			(_context, _options, _state, model) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return fauxAssistantMessage("child response");
			},
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: root.getModel("root-model")!,
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
			const waitForIdle = async (): Promise<void> => {
				for (let attempt = 0; attempt < 50; attempt++) {
					const snapshot = await client.request({ command: "session/read", sessionId });
					if (
						snapshot.ok &&
						"result" in snapshot &&
						(snapshot.result as { session: { phase: string } }).session.phase === "idle"
					)
						return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error("Timed out waiting for root turn completion");
			};
			const waitForOperation = async (operationId: string): Promise<void> => {
				for (let attempt = 0; attempt < 50; attempt++) {
					const operation = await client.request({ command: "operation/read", sessionId, operationId });
					if (
						operation.ok &&
						"result" in operation &&
						(operation.result as { operation?: { state?: string } }).operation?.state === "complete"
					)
						return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error("Timed out waiting for model-switch operation completion");
			};
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			await client.request({ command: "session/name/auto/set", sessionId, payload: { enabled: false } });
			const first = await client.request({ command: "turn/start", sessionId, payload: { text: "root first" } });
			if (!first.ok || !("accepted" in first)) throw new Error("First root turn was not accepted");
			await waitForIdle();
			const beforeSwitch = await client.request({ command: "session/read", sessionId });
			if (!beforeSwitch.ok || !("result" in beforeSwitch)) throw new Error("Session read failed");
			const transcriptBeforeSwitch = (
				beforeSwitch.result as unknown as { session: { transcript: readonly unknown[] } }
			).session.transcript;
			const spawned = await client.request({
				command: "agent/spawn",
				sessionId,
				payload: {
					taskName: "resolved-child",
					taskMessage: "use the child profile",
					model: { provider: "coding-agent-daemon-resolved-child-faux", id: "child-model" },
				},
			});
			if (!spawned.ok || !("result" in spawned)) throw new Error("Child spawn failed");
			const agentId = (spawned.result as { agent: { id: string } }).agent.id;
			await client.request({ command: "agent/wait", payload: { agentId } });
			const switched = await client.request({
				command: "session/model/set",
				sessionId,
				payload: { provider: "coding-agent-daemon-root-models-faux", id: "switched-root-model" },
			});
			if (!switched.ok || !("accepted" in switched)) throw new Error("Model switch was not accepted");
			await waitForOperation(switched.accepted.operationId);
			const switchedSnapshot = await client.request({ command: "session/read", sessionId });
			if (!switchedSnapshot.ok || !("result" in switchedSnapshot)) throw new Error("Session read failed");
			expect((switchedSnapshot.result as { session: { model: unknown } }).session.model).toEqual({
				provider: "coding-agent-daemon-root-models-faux",
				id: "switched-root-model",
			});
			const afterSwitch = await client.request({ command: "session/read", sessionId });
			if (!afterSwitch.ok || !("result" in afterSwitch)) throw new Error("Session read failed");
			expect(
				(afterSwitch.result as unknown as { session: { transcript: readonly unknown[] } }).session.transcript,
			).toEqual(transcriptBeforeSwitch);
			const second = await client.request({ command: "turn/start", sessionId, payload: { text: "root second" } });
			if (!second.ok || !("accepted" in second)) throw new Error("Second root turn was not accepted");
			await waitForIdle();
			expect(requestedModels).toEqual([
				"coding-agent-daemon-root-models-faux/root-model",
				"coding-agent-daemon-resolved-child-faux/child-model",
				"coding-agent-daemon-root-models-faux/switched-root-model",
			]);
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
