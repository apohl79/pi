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

describe("coding-agent daemon runtime", () => {
	test("composes the SQLite service, daemon lifecycle, and CLI runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-faux",
			models: [{ id: "coding-agent-daemon-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const output: unknown[] = [];
		let started = false;
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "pi.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: (value) => output.push(value),
			createServer: (_service, options) => ({
				id: "daemon-1",
				addresses: [`unix://${options.path}`],
				start: async () => {
					started = true;
				},
				close: async () => {
					started = false;
				},
			}),
		});
		await runtime.cli.runServer({ command: "server", action: "start" });
		expect(started).toBe(true);
		expect(runtime.daemon.status()).toEqual({
			state: "running",
			serverId: "daemon-1",
			addresses: [`unix://${join(directory, "pi.sock")}`],
		});
		expect(await runtime.service.listSessions()).toEqual([]);
		expect(output).toHaveLength(1);
		await runtime.close();
		expect(started).toBe(false);
	});
});
