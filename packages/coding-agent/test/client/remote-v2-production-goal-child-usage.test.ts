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

describe("production remote v2 goal child usage", () => {
	test("attributes cross-provider child usage to the parent goal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-goal-child-usage-"));
		directories.push(directory);
		const models = createModels();
		const parent = fauxProvider({
			provider: "coding-agent-remote-goal-child-parent-faux",
			models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const child = fauxProvider({
			provider: "coding-agent-remote-goal-child-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(parent.provider);
		models.setProvider(child.provider);
		child.setResponses([
			{
				...fauxAssistantMessage("child completed"),
				usage: {
					input: 3,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.2 },
				},
			},
		]);
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
				const goalOperation = await session.createGoal("include child work", 100);
				await session.waitForOperation(goalOperation);
				const agent = await session.spawnAgent("specialist", "complete the child task", {
					model: { provider: child.provider.id, id: "child-model" },
				});
				expect((await session.waitAgent(agent.id)).state).toBe("complete");
				const goal = await session.readGoal();
				expect(goal).toMatchObject({ objective: "include child work", status: "active", tokensUsed: 5 });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
