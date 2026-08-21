import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { BlobV2ImageService, InMemoryV2BlobStore, LocalV2FileReferenceService } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createViewImageRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-view-image-faux",
		models: [
			{ id: "coding-agent-daemon-view-image-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
		],
	});
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("view_image", { reference: "source.png" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("image metadata received"),
	]);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { activeToolNames: ["view_image"] },
		images: new BlobV2ImageService(
			new LocalV2FileReferenceService({ projectRoot: directory, cwd: directory, allowAbsolute: true }),
			new InMemoryV2BlobStore(),
		),
		write: () => {},
	});
}

describe("production daemon view_image tool", () => {
	test("routes a model image-view call through the configured image service", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-view-image-tool-"));
		directories.push(directory);
		await writeFile(join(directory, "source.png"), new Uint8Array([137, 80, 78, 71]));
		const runtime = await createViewImageRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("inspect the source image");
				const snapshot = await session.waitForOperation(operationId);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "tool" &&
							item.content.some(
								(part) => part.type === "text" && part.text.includes('"reference":"source.png"'),
							),
					),
				).toBe(true);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "assistant" &&
							item.content.some((part) => part.type === "text" && part.text === "image metadata received"),
					),
				).toBe(true);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
