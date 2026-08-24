import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 session import", () => {
	test("creates a durable imported session and reattaches the live client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-import-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-import-faux",
			models: [{ id: "remote-import-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
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
			const created = await client.createSession({ cwd: directory });
			const attachment = await new RemoteV2SessionSelector(client).attachView(created.id, { mode: "control" });
			try {
				const importedId = await attachment.session.importAndAttach({
					cwd: directory,
					jsonl: `${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: new Date().toISOString(), cwd: directory })}\n${JSON.stringify({ type: "message", id: "message-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "imported prompt" }], timestamp: Date.now() } })}\n`,
				});
				expect(importedId).not.toBe(created.id);
				expect(attachment.session.snapshot?.id).toBe(importedId);
				expect(attachment.session.snapshot?.transcript).toEqual(
					expect.arrayContaining([expect.objectContaining({ role: "user" })]),
				);
			} finally {
				await attachment.session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
