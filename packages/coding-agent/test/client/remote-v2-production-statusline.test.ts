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

describe("production remote v2 statusline", () => {
	test("runs against the server-authoritative session payload and reports failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-statusline-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-statusline-faux",
			models: [{ id: "remote-statusline-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
		const payloads: unknown[] = [];
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const goalOperation = await session.createGoal("statusline goal");
				await session.waitForOperation(goalOperation);
				const runner = new StatuslineRunner({
					command: "codex-statusline",
					execute: async (_command, payload) => {
						payloads.push(JSON.parse(payload));
						return { stdout: "remote status", stderr: "", exitCode: 0 };
					},
				});
				const controller = new RemoteV2StatuslineController(session, runner, {
					cwd: directory,
					transcriptPath: join(directory, "session.jsonl"),
				});
				try {
					await controller.refresh();
					expect(controller.snapshot.output).toBe("remote status");
					expect(payloads[0]).toMatchObject({
						harness: "pi",
						session_id: session.snapshot?.id,
						cwd: directory,
						server: { connected: true, detachable: true },
						goal: { status: "active" },
					});
					await controller.setCommand("broken-statusline");
					const failing = new StatuslineRunner({
						command: "broken-statusline",
						execute: async () => ({ stdout: "", stderr: "bad statusline", exitCode: 7 }),
					});
					const failingController = new RemoteV2StatuslineController(session, failing, {
						cwd: directory,
						transcriptPath: join(directory, "session.jsonl"),
					});
					try {
						await failingController.refresh();
						expect(failingController.snapshot.error).toBe("bad statusline");
					} finally {
						await failingController.dispose();
					}
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
