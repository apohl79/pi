import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import {
	AdapterV2WebService,
	BlobV2ImageService,
	InMemoryV2BlobStore,
	LocalV2FileReferenceService,
} from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 web and image services", () => {
	test("routes web and image requests through the RemoteV2Session client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-web-image-"));
		directories.push(directory);
		await writeFile(join(directory, "source.png"), new Uint8Array([137, 80, 78, 71]));
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-web-image-faux",
			models: [{ id: "remote-web-image-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
			web: new AdapterV2WebService({
				execute: async () => [
					{
						id: "remote-web-result",
						title: "Remote result",
						source: "fixture",
						retrievedAt: 1,
						url: "https://example.test/remote",
						extract: "remote extract",
					},
				],
			}),
			images: new BlobV2ImageService(
				new LocalV2FileReferenceService({ projectRoot: directory, cwd: directory, allowAbsolute: true }),
				new InMemoryV2BlobStore(),
				{
					generate: async () => ({
						data: new Uint8Array([1, 2, 3]),
						mimeType: "image/png",
						provider: "remote-image-provider",
						model: "remote-image-model",
						costUsd: 0.04,
					}),
				},
			),
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				expect(await session.webRequest("search_query", { query: "remote" })).toEqual([
					expect.objectContaining({ id: "remote-web-result", extract: "remote extract" }),
				]);
				expect(await session.viewImage("source.png")).toMatchObject({ mimeType: "image/png", size: 4 });
				expect(await session.generateImage("a remote tree")).toMatchObject({
					mimeType: "image/png",
					provider: "remote-image-provider",
					model: "remote-image-model",
					costUsd: 0.04,
				});
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
