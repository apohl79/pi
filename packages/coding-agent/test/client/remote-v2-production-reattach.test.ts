import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 reattach", () => {
	test("preserves the session identity and transcript across detach/reattach", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-reattach-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-reattach-faux",
			models: [{ id: "remote-reattach-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("durable remote response")]);
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
			const first = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			const sessionId = first.id;
			if (!sessionId) throw new Error("Session id unavailable");
			try {
				const operationId = await first.submit("persist this remote turn");
				await first.waitForOperation(operationId);
				expect(first.snapshot?.transcript).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							content: [expect.objectContaining({ type: "text", text: "durable remote response" })],
						}),
					]),
				);
			} finally {
				await first.dispose();
			}
			const reattached = await RemoteV2Session.open(client, sessionId, { mode: "control" });
			try {
				expect(reattached.id).toBe(sessionId);
				expect(reattached.snapshot?.transcript).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							content: [expect.objectContaining({ type: "text", text: "durable remote response" })],
						}),
					]),
				);
			} finally {
				await reattached.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
