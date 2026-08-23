import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 agent lifetime", () => {
	test("keeps a child alive after the parent turn and interrupts it remotely", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-agent-lifetime-"));
		directories.push(directory);
		const models = createModels();
		const parent = fauxProvider({
			provider: "coding-agent-remote-agent-lifetime-parent-faux",
			models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const child = fauxProvider({
			provider: "coding-agent-remote-agent-lifetime-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(parent.provider);
		models.setProvider(child.provider);
		parent.setResponses([fauxAssistantMessage("parent completed")]);
		child.setResponses([() => new Promise(() => {})]);
		const socketPath = join(directory, "server.sock");
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
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const agent = await session.spawnAgent("long-lived", "keep working", {
					model: { provider: child.provider.id, id: "child-model" },
				});
				await waitForAgentState(session, agent.id, "running");
				const parentOperation = await session.submit("finish the parent turn");
				await session.waitForOperation(parentOperation);
				expect((await session.listAgents()).find((candidate) => candidate.id === agent.id)?.state).toBe("running");
				expect((await session.interruptAgent(agent.id)).state).toBe("interrupted");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function waitForAgentState(session: RemoteV2Session, agentId: string, state: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await session.listAgents()).find((agent) => agent.id === agentId)?.state === state) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for agent ${agentId} to become ${state}`);
}
