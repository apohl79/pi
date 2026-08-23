import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalContinuationScheduler } from "@earendil-works/pi-agent-core";
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

describe("production remote v2 goal continuation", () => {
	test("schedules an active goal after a remote turn reaches idle", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-goal-continuation-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-goal-faux",
			models: [{ id: "remote-goal-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("goal response")]);
		const continuations: string[] = [];
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
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
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const goalOperation = await session.createGoal("continue remote work");
				await session.waitForOperation(goalOperation);
				const turnOperation = await session.submit("work remotely");
				await session.waitForOperation(turnOperation);
				for (let attempt = 0; attempt < 50 && continuations.length === 0; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(continuations).toEqual(["continue remote work"]);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
