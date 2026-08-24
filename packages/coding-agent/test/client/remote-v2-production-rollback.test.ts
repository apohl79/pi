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

function entryIdForText(entries: readonly unknown[], text: string): string {
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const candidate = entry as { id?: unknown; message?: unknown };
		if (typeof candidate.id !== "string" || typeof candidate.message !== "object" || candidate.message === null)
			continue;
		if (JSON.stringify(candidate.message).includes(text)) return candidate.id;
	}
	throw new Error(`Tree entry containing ${text} was not found`);
}

describe("production remote v2 rollback commands", () => {
	test("reconstructs the active conversation through /rollback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-rollback-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-rollback-faux",
			models: [{ id: "remote-rollback-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
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
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const naming = await attachment.session.setAutoName(false);
				await attachment.session.waitForOperation(naming);
				for (const prompt of ["first request", "second request"]) {
					const submitted = await adapter.submit(prompt);
					await attachment.session.waitForOperation(submitted);
				}
				const tree = await attachment.session.readTree();
				const firstRequest = entryIdForText(tree.entries, "first request");
				const secondRequest = entryIdForText(tree.entries, "second request");
				expect(tree.leafId).not.toBeNull();
				expect(tree.labels).toEqual({});
				const navigate = await attachment.session.navigateTree(firstRequest);
				await attachment.session.waitForOperation(navigate);
				expect((await attachment.session.readTree()).leafId).toBe(firstRequest);
				const restore = await attachment.session.navigateTree(secondRequest);
				await attachment.session.waitForOperation(restore);
				const rollback = await adapter.execute("/rollback 2");
				await attachment.session.waitForOperation(operationId(rollback));
				expect(
					attachment.session.snapshot?.transcript?.some((item) => JSON.stringify(item).includes("first request")),
				).toBe(false);
				expect(
					attachment.session.snapshot?.transcript?.some((item) => JSON.stringify(item).includes("second request")),
				).toBe(false);
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
