import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 unsafe-tool recovery", () => {
	test("reopens needsResolution state and verifies its diagnostic bundle", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-unsafe-recovery-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-unsafe-recovery-faux",
			models: [{ id: "remote-unsafe-recovery-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath,
				harness: { tools: [], activeToolNames: [] },
				write: () => {},
			});
		const first = await createRuntime();
		let sessionId = "";
		try {
			await first.daemon.start();
			if (!first.service.createSession) throw new Error("Configured service cannot create sessions");
			const created = await first.service.createSession({ cwd: directory });
			sessionId = created.sessionId;
			const metadata = (await first.repository.list()).find((item) => item.id === sessionId);
			if (!metadata) throw new Error("Session metadata was not persisted");
			const session = await first.repository.open(metadata);
			await session.appendRecord({
				type: "operation_started",
				id: "crashed-unsafe-turn",
				lane: "main",
				sourceLeafId: null,
				intent: { kind: "run", originalPrompt: [], initialMessages: [] },
			});
			await session.appendRecord({
				type: "tool_started",
				id: "crashed-tool-start",
				lane: "main",
				runId: "crashed-unsafe-turn",
				assistantEntryId: "assistant-entry",
				toolIndex: 0,
				toolCallId: "unsafe-call",
				toolName: "exec_command",
				effectiveArgs: { command: "touch must-not-replay" },
				resultEntryId: "tool-result",
				replay: "never",
			});
		} finally {
			await first.close();
		}

		const second = await createRuntime();
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await second.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.open(client, sessionId, { mode: "observer" });
			try {
				expect(session.snapshot?.persistence.recoveryState).toBe("needsResolution");
				const bundle = await session.diagnosticsExport({ sessionId });
				const serialized = JSON.stringify(bundle);
				expect(serialized).toContain("needsResolution");
				expect(await session.diagnosticsVerify(bundle)).toMatchObject({ valid: true });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await second.close();
		}
	});
});
