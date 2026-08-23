import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 fork and delete", () => {
	test("creates an independent durable branch and removes it through the daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-fork-delete-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-fork-faux",
			models: [{ id: "remote-fork-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("source response")]);
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
				const sourceOperation = await source.submit("preserve this branch");
				await source.waitForOperation(sourceOperation);
				const forked = await source.fork({ name: "review branch" });
				try {
					expect(forked.id).not.toBe(source.id);
					expect(forked.snapshot?.name).toBe("review branch");
					expect(forked.snapshot?.transcript).toEqual(
						expect.arrayContaining([expect.objectContaining({ text: "source response" })]),
					);
				} finally {
					const forkedId = forked.id;
					await forked.delete();
					expect((await new RemoteV2SessionSelector(client).list()).some((entry) => entry.id === forkedId)).toBe(
						false,
					);
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
