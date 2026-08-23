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

function createModelsWithChildResponse(childPrompts?: string[]) {
	const models = createModels();
	const parent = fauxProvider({
		provider: "coding-agent-daemon-restart-parent-faux",
		models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	const child = fauxProvider({
		provider: "coding-agent-daemon-restart-child-faux",
		models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(parent.provider);
	models.setProvider(child.provider);
	child.setResponses([
		(context) => {
			childPrompts?.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("child survived restart");
		},
	]);
	return { models, parent };
}

function resultOf<T>(response: unknown): T {
	return (response as { result: T }).result;
}

async function spawnCompletedChild(
	directory: string,
	socketPath: string,
	childPrompts?: string[],
): Promise<{ sessionId: string; agentId: string }> {
	const { models, parent } = createModelsWithChildResponse(childPrompts);
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		socketPath,
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	try {
		await runtime.daemon.start();
		await client.connect();
		const created = await client.request({ command: "session/create", payload: { cwd: directory } });
		const sessionId = resultOf<{ session: { id: string } }>(created).session.id;
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		const spawned = await client.request({
			command: "agent/spawn",
			sessionId,
			payload: {
				taskName: "durable-child",
				taskMessage: "persist this child",
				model: { provider: "coding-agent-daemon-restart-child-faux", id: "child-model" },
			},
		});
		const agentId = resultOf<{ agent: { id: string } }>(spawned).agent.id;
		const waited = await client.request({ command: "agent/wait", payload: { agentId } });
		expect(waited).toMatchObject({ ok: true, result: { agent: { id: agentId, state: "complete" } } });
		return { sessionId, agentId };
	} finally {
		client.dispose();
		await runtime.close();
	}
}

async function sendMessageBeforeRestart(
	directory: string,
	socketPath: string,
	sessionId: string,
	agentId: string,
): Promise<void> {
	const { models, parent } = createModelsWithChildResponse();
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		socketPath,
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	try {
		await runtime.daemon.start();
		await client.connect();
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		await client.request({ command: "agent/message", payload: { agentId, message: "survive the daemon restart" } });
	} finally {
		client.dispose();
		await runtime.close();
	}
}

async function followUpAfterRestart(
	directory: string,
	socketPath: string,
	sessionId: string,
	agentId: string,
	childPrompts: string[],
): Promise<void> {
	const { models, parent } = createModelsWithChildResponse(childPrompts);
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		socketPath,
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	try {
		await runtime.daemon.start();
		await client.connect();
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		await client.request({ command: "agent/followUp", payload: { agentId, message: "continue after restart" } });
		await client.request({ command: "agent/wait", payload: { agentId } });
	} finally {
		client.dispose();
		await runtime.close();
	}
}

async function listAfterRestart(directory: string, socketPath: string, sessionId: string): Promise<unknown> {
	const { models, parent } = createModelsWithChildResponse();
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		socketPath,
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	try {
		await runtime.daemon.start();
		await client.connect();
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		const listed = await client.request({ command: "agent/list", sessionId });
		return listed;
	} finally {
		client.dispose();
		await runtime.close();
	}
}

async function spawnDuplicateAfterRestart(directory: string, socketPath: string, sessionId: string): Promise<unknown> {
	const { models, parent } = createModelsWithChildResponse();
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
		socketPath,
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	try {
		await runtime.daemon.start();
		await client.connect();
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		return await client.request({
			command: "agent/spawn",
			sessionId,
			payload: {
				taskName: "durable-child",
				taskMessage: "do not duplicate this child",
				model: { provider: "coding-agent-daemon-restart-child-faux", id: "child-model" },
			},
		});
	} finally {
		client.dispose();
		await runtime.close();
	}
}

describe("coding-agent daemon child durability", () => {
	test("rehydrates a completed child agent after daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agent-restart-"));
		directories.push(directory);
		const socketPath = join(directory, "server.sock");
		const { sessionId, agentId } = await spawnCompletedChild(directory, socketPath);
		const listed = await listAfterRestart(directory, socketPath, sessionId);
		expect(listed).toMatchObject({
			ok: true,
			result: {
				agents: [
					{
						id: agentId,
						taskName: "durable-child",
						state: "complete",
						model: { provider: "coding-agent-daemon-restart-child-faux", id: "child-model" },
					},
				],
			},
		});
		expect(await spawnDuplicateAfterRestart(directory, socketPath, sessionId)).toMatchObject({ ok: false });
	});

	test("rehydrates a queued child message after daemon restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-agent-message-restart-"));
		directories.push(directory);
		const socketPath = join(directory, "server.sock");
		const childPrompts: string[] = [];
		const { sessionId, agentId } = await spawnCompletedChild(directory, socketPath, childPrompts);
		await sendMessageBeforeRestart(directory, socketPath, sessionId, agentId);
		await followUpAfterRestart(directory, socketPath, sessionId, agentId, childPrompts);
		expect(childPrompts).toEqual(expect.arrayContaining([expect.stringContaining("survive the daemon restart")]));
	});
});
