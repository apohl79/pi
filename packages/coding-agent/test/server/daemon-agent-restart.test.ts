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

function createModelsWithChildResponse() {
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
	child.setResponses([fauxAssistantMessage("child survived restart")]);
	return { models, parent };
}

function resultOf<T>(response: unknown): T {
	return (response as { result: T }).result;
}

async function spawnCompletedChild(
	directory: string,
	socketPath: string,
): Promise<{ sessionId: string; agentId: string }> {
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
	});
});
