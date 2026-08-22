import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon unsafe-tool recovery", () => {
	test("requires explicit resolution after a non-replay-safe tool starts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-unsafe-tool-recovery-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-unsafe-tool-recovery-faux",
			models: [{ id: "unsafe-tool-recovery-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const output: unknown[] = [];
		const createRuntime = () =>
			createConfiguredCodingAgentDaemonRuntime({
				agentDir: directory,
				cwd: directory,
				models,
				model: faux.getModel(),
				socketPath,
				harness: { tools: [], activeToolNames: [] },
				write: (value: unknown) => output.push(value),
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
				intent: {
					kind: "run",
					originalPrompt: [{ role: "user", content: [{ type: "text", text: "run unsafe tool" }], timestamp: 1 }],
					initialMessages: [],
				},
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
			const snapshot = await client.request({ command: "session/read", sessionId });
			expect(snapshot).toMatchObject({
				ok: true,
				result: { session: { phase: "idle", persistence: { recoveryState: "needsResolution" } } },
			});
			expect(faux.state.callCount).toBe(0);
			const bundlePath = join(directory, "unsafe-tool-recovery-bundle.json");
			await second.cli.runDiagnostics({ command: "diagnostics", action: "export", sessionId, output: bundlePath });
			const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as { events: readonly unknown[] };
			const serialized = JSON.stringify(bundle);
			expect(bundle.events.length).toBeGreaterThan(0);
			expect(serialized).toContain("needsResolution");
			expect(serialized).toContain("sessionSnapshots");
			await second.cli.runDiagnostics({ command: "diagnostics", action: "verify", bundle: bundlePath });
			expect(output.at(-1)).toEqual({ valid: true });
		} finally {
			client.dispose();
			await second.close();
		}
	});
});
