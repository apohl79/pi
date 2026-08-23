import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session, RemoteV2StatuslineController } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";
import { StatuslineRunner } from "../../src/server/statusline.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 statusline configuration", () => {
	test("accepts array-form configured commands", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-statusline-array-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-statusline-array-faux",
			models: [{ id: "remote-statusline-array-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
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
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const runner = new StatuslineRunner({
					execute: async (command) => ({
						stdout: command.toString().replaceAll(",", " "),
						stderr: "",
						exitCode: 0,
					}),
				});
				const controller = new RemoteV2StatuslineController(session, runner, {
					cwd: directory,
					transcriptPath: join(directory, "session.jsonl"),
				});
				try {
					await controller.setCommand(["codex-statusline", "--json"]);
					expect(controller.snapshot.output).toBe("codex-statusline --json");
				} finally {
					await controller.dispose();
				}
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
