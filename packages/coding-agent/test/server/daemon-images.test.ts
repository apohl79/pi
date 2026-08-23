import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { BlobV2ImageService, InMemoryV2BlobStore, LocalV2FileReferenceService } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createImageRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-images-faux",
		models: [{ id: "coding-agent-daemon-images-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { tools: [], activeToolNames: [] },
		images: new BlobV2ImageService(
			new LocalV2FileReferenceService({ projectRoot: directory, cwd: directory, allowAbsolute: true }),
			new InMemoryV2BlobStore(),
			{
				generate: async () => ({
					data: new Uint8Array([1, 2, 3]),
					mimeType: "image/png",
					provider: "configured-image-provider",
					model: "configured-image-model",
					costUsd: 0.04,
				}),
			},
		),
		write: () => {},
	});
}

describe("coding-agent daemon image workflow", () => {
	test("routes image view and generation through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-images-"));
		directories.push(directory);
		await writeFile(join(directory, "source.png"), new Uint8Array([137, 80, 78, 71]));
		const runtime = await createImageRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			expect(created).toMatchObject({ ok: true, result: { session: { id: expect.any(String) } } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const viewed = await client.request({
				command: "image/view",
				sessionId,
				payload: { reference: "source.png" },
			});
			const generated = await client.request({
				command: "image/generate",
				sessionId,
				payload: { prompt: "a small tree" },
			});
			expect(viewed).toMatchObject({
				ok: true,
				result: { image: { mimeType: "image/png", size: 4, reference: "source.png" } },
			});
			expect(generated).toMatchObject({
				ok: true,
				result: {
					image: {
						mimeType: "image/png",
						size: 3,
						provider: "configured-image-provider",
						model: "configured-image-model",
						costUsd: 0.04,
					},
				},
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
