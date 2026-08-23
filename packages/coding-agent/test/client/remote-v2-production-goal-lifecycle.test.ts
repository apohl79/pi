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

describe("production remote v2 goal lifecycle", () => {
	test("creates, updates, pauses, resumes, and completes a durable goal remotely", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-goal-lifecycle-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-goal-lifecycle-faux",
			models: [{ id: "remote-goal-lifecycle-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
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
				await complete(session, await session.createGoal("ship remote lifecycle", 100));
				expect(await session.readGoal()).toMatchObject({
					objective: "ship remote lifecycle",
					status: "active",
					tokenBudget: 100,
				});
				await complete(session, await session.updateGoal({ tokensUsed: 12, activeTimeSeconds: 4 }));
				expect(await session.readGoal()).toMatchObject({ tokensUsed: 12, activeTimeSeconds: 4 });
				await complete(session, await session.pauseGoal());
				expect(await session.readGoal()).toMatchObject({ status: "paused" });
				await complete(session, await session.resumeGoal());
				expect(await session.readGoal()).toMatchObject({ status: "active" });
				await complete(session, await session.updateGoal({ status: "complete" }));
				expect(await session.readGoal()).toMatchObject({ status: "complete" });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function complete(session: RemoteV2Session, operationId: string): Promise<void> {
	await session.waitForOperation(operationId);
	expect((await session.readOperation(operationId)).state).toBe("complete");
}
