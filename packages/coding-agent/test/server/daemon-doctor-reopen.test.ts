import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon SQLite doctor", () => {
	test("reports that the SQLite inspection used a reopened connection", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-doctor-reopen-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-doctor-reopen-faux",
			models: [{ id: "doctor-reopen-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const output: unknown[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: (value) => output.push(value),
		});
		try {
			await runtime.daemon.start();
			await runtime.cli.runDiagnostics({ command: "diagnostics", action: "doctor" });
			const result = output.at(-1) as { checks: Array<{ name: string; details?: Record<string, unknown> }> };
			expect(result.checks.find((check) => check.name === "sqlite")).toMatchObject({
				details: { reopened: true, quickCheck: ["ok"], foreignKeyErrors: 0 },
			});
		} finally {
			await runtime.close();
		}
	});
});
