import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { type RemoteV2CommandResult, RemoteV2InteractiveAttachment, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function operationId(result: RemoteV2CommandResult): string {
	if (result.kind !== "operation") throw new Error("Expected a remote operation result");
	return result.operationId;
}

describe("production remote v2 compaction", () => {
	test("executes /compact through the daemon and projects a summary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-compaction-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-compaction-faux",
			models: [{ id: "remote-compaction-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		faux.setResponses([fauxAssistantMessage("initial response"), fauxAssistantMessage("preserved remote summary")]);
		models.setProvider(faux.provider);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			compaction: () => ({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 }),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const initial = await adapter.submit("capture the remote state");
				await attachment.session.waitForOperation(initial);
				const compact = await adapter.execute("/compact preserve remote contract");
				await attachment.session.waitForOperation(operationId(compact));
				expect((await attachment.session.readOperation(operationId(compact))).state).toBe("complete");
				expect(attachment.session.snapshot?.transcript).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ role: "compactionSummary", summary: "preserved remote summary" }),
					]),
				);
				expect(attachment.session.phase).toBe("idle");
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
