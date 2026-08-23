import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon compaction policy", () => {
	test("projects and toggles the configured policy over Unix v2", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-compaction-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-compaction-faux",
			models: [
				{ id: "coding-agent-daemon-compaction-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			compaction: () => ({ enabled: true, reserveTokens: 123, keepRecentTokens: 456 }),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				expect(session.snapshot?.compactionPolicy).toMatchObject({
					enabled: true,
					reserveTokens: 123,
					keepRecentTokens: 456,
					contextWindow: 32_000,
				});
				const operationId = await session.setAutoCompaction(false);
				await session.waitForOperation(operationId);
				expect(session.snapshot?.compactionPolicy).toMatchObject({ enabled: false, reserveTokens: 123 });
				expect((await session.readOperation(operationId)).state).toBe("complete");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
