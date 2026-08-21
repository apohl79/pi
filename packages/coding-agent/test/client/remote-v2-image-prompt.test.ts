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

async function createImagePromptRuntime(
	directory: string,
	provider: string,
	modelId: string,
	input: ("text" | "image")[],
	response: string,
) {
	const models = createModels();
	const faux = fauxProvider({
		provider,
		models: [{ id: modelId, reasoning: false, input, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(response)]);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
}

async function uploadImage(client: PiClientV2): Promise<string> {
	const blob = await client.request({
		command: "blob/put",
		payload: { data: "iVBORw0KGgo=", encoding: "base64", mimeType: "image/png" },
	});
	expect(blob).toMatchObject({ ok: true, result: { blob: { digest: expect.any(String) } } });
	return (blob as unknown as { result: { blob: { digest: string } } }).result.blob.digest;
}

describe("remote v2 image prompts", () => {
	test("resolves a blob-backed image through the production daemon session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-image-prompt-"));
		directories.push(directory);
		const runtime = await createImagePromptRuntime(
			directory,
			"coding-agent-remote-image-prompt-faux",
			"coding-agent-remote-image-prompt-model",
			["text", "image"],
			"image prompt received",
		);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const digest = await uploadImage(client);
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

	test("rejects image input before a text-only model turn starts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-image-reject-"));
		directories.push(directory);
		const runtime = await createImagePromptRuntime(
			directory,
			"coding-agent-remote-image-reject-faux",
			"coding-agent-remote-image-reject-model",
			["text"],
			"must not run",
		);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const digest = await uploadImage(client);
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit([{ type: "image", digest, mimeType: "image/png" }]);
				const snapshot = await session.waitForOperation(operationId);
				expect(snapshot.phase).toBe("failed");
				expect(snapshot.transcript.some((item) => item.role === "user")).toBe(false);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
