import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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
						childPrompts?.push(JSON.stringify(context.messages));
						return (
							childControl?.waitBeforeFirstResponse?.then(() => fauxAssistantMessage("child completed")) ??
							fauxAssistantMessage("child completed")
						);
					},
					(context) => {
						childPrompts?.push(JSON.stringify(context.messages));
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
});
