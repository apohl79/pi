import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("remote v2 image prompts", () => {
	test("resolves a blob-backed image through the production daemon session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-image-prompt-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-image-prompt-faux",
			models: [
				{ id: "coding-agent-remote-image-prompt-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("image prompt received")]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const blob = await client.request({
				command: "blob/put",
				payload: { data: "iVBORw0KGgo=", encoding: "base64", mimeType: "image/png" },
			});
			expect(blob).toMatchObject({ ok: true, result: { blob: { digest: expect.any(String) } } });
			const digest = (blob as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit([
					{ type: "text", text: "inspect this image" },
					{ type: "image", digest, mimeType: "image/png" },
				]);
				const snapshot = await session.waitForOperation(operationId);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "user" &&
							item.content.some((part) => part.type === "image" && part.mimeType === "image/png"),
					),
				).toBe(true);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "assistant" &&
							item.content.some((part) => part.type === "text" && part.text === "image prompt received"),
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
