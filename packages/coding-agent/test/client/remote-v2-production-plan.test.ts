import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
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

describe("production remote v2 plan commands", () => {
	test("projects /plan and /plan-clear through the daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-plan-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-plan-faux",
			models: [{ id: "remote-plan-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const updated = await adapter.execute('/plan [{"step":"verify remote plan","status":"in_progress"}]');
				await attachment.session.waitForOperation(operationId(updated));
				expect(attachment.session.snapshot?.plan).toEqual({
					version: 1,
					items: [{ step: "verify remote plan", status: "in_progress" }],
				});
				const cleared = await adapter.execute("/plan-clear");
				await attachment.session.waitForOperation(operationId(cleared));
				expect(attachment.session.snapshot?.plan).toBeUndefined();
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
