import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { createCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon runtime", () => {
	test("composes the SQLite service, daemon lifecycle, and CLI runtime", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-daemon-"));
		directories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const repository = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-faux",
			models: [{ id: "coding-agent-daemon-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const output: unknown[] = [];
		let started = false;
		try {
			const runtime = await createCodingAgentDaemonRuntime({
				repository,
				models,
				env,
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
			await expect(
				runtime.cli.runServer({ command: "server", action: "start", listen: [{ transport: "unix", path: "/tmp/other.sock" }] }),
			).rejects.toThrow("--listen is not supported");
			await expect(runtime.cli.runServer({ command: "server", action: "start", auth: { type: "token", token: "secret" } })).rejects.toThrow(
				"authentication is not supported",
			);
			await runtime.close();
			expect(started).toBe(false);
		} finally {
			await repository.close();
			await env.cleanup();
		}
	});
});
