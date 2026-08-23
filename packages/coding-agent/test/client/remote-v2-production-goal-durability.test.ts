import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 goal durability", () => {
	test("reattaches the goal after restart and forks an independent goal identity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-goal-durability-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-goal-durability-faux",
			models: [{ id: "goal-durability-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath,
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const firstRuntime = await createRuntime();
		const firstClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		let sourceId = "";
		let sourceGoalId = "";
		try {
			await firstRuntime.daemon.start();
			await firstClient.connect();
			const source = await RemoteV2Session.create(firstClient, { cwd: directory }, { mode: "control" });
			try {
				sourceId = source.id!;
				await complete(source, await source.createGoal("durable remote work", 100));
				await complete(source, await source.updateGoal({ tokensUsed: 7 }));
				sourceGoalId = String((await source.readGoal())?.id);
				const forked = await source.fork({ scope: "tree" });
				try {
					const forkedGoal = await forked.readGoal();
					expect(forkedGoal).toMatchObject({ objective: "durable remote work", tokensUsed: 7 });
					expect(String(forkedGoal?.id)).not.toBe(sourceGoalId);
				} finally {
					await forked.dispose();
				}
			} finally {
				await source.dispose();
			}
		} finally {
			firstClient.dispose();
			await firstRuntime.close();
		}

		const secondRuntime = await createRuntime();
		const secondClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await secondRuntime.daemon.start();
			await secondClient.connect();
			const restored = await RemoteV2Session.open(secondClient, sourceId, { mode: "control" });
			try {
				expect(await restored.readGoal()).toMatchObject({ id: sourceGoalId, tokensUsed: 7, status: "active" });
			} finally {
				await restored.dispose();
			}
		} finally {
			secondClient.dispose();
			await secondRuntime.close();
		}
	});
});

async function complete(session: RemoteV2Session, operationId: string): Promise<void> {
	await session.waitForOperation(operationId);
	const operation = await session.readOperation(operationId);
	expect(operation?.state, JSON.stringify(operation)).toBe("complete");
}
