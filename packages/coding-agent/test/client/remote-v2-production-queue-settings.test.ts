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

describe("production remote v2 queue settings", () => {
	test("projects steering, follow-up, and compaction settings through the daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-queue-settings-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-queue-settings-faux",
			models: [{ id: "remote-queue-settings-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
				for (const [operationId, expected] of [
					[await session.setSteeringMode("one-at-a-time"), { steeringMode: "one-at-a-time" }],
					[await session.setFollowUpMode("one-at-a-time"), { followUpMode: "one-at-a-time" }],
					[await session.setAutoCompaction(false), { compactionEnabled: false }],
				] as const) {
					await session.waitForOperation(operationId);
					expect((await session.readOperation(operationId)).state).toBe("complete");
					await session.refresh();
					if ("steeringMode" in expected) expect(session.snapshot?.steeringMode).toBe(expected.steeringMode);
					if ("followUpMode" in expected) expect(session.snapshot?.followUpMode).toBe(expected.followUpMode);
					if ("compactionEnabled" in expected)
						expect(session.snapshot?.compactionPolicy?.enabled).toBe(expected.compactionEnabled);
				}
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
