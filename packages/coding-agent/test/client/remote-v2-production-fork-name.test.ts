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

describe("production remote v2 forked names", () => {
	test("marks a copied title as derived and keeps later edits independent", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-fork-name-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-fork-name-faux",
			models: [{ id: "remote-fork-name-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
			const source = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const sourceName = await source.setName("Source title");
				await source.waitForOperation(sourceName);
				const forked = await source.fork();
				try {
					expect(forked.snapshot).toMatchObject({ name: "Source title", nameSource: "derived" });
					const forkName = await forked.setName("Fork title");
					await forked.waitForOperation(forkName);
					expect(forked.snapshot).toMatchObject({ name: "Fork title", nameSource: "explicit" });
					await source.refresh();
					expect(source.snapshot).toMatchObject({ name: "Source title", nameSource: "explicit" });
				} finally {
					await forked.delete();
				}
			} finally {
				await source.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
