import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { NodeV2ProcessRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 PTY reattach", () => {
	test("preserves a detached PTY until a new control session reads it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-pty-reattach-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-pty-reattach-faux",
			models: [{ id: "remote-pty-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const processes = new NodeV2ProcessRegistry({
			ptyLauncher: {
				spawn: (request) =>
					spawn(
						process.execPath,
						[
							"-e",
							"process.stdin.once('data', data => { process.stdout.write('pty:' + data); process.exit(0); })",
						],
						{
							cwd: request.cwd,
							env: { ...env, ...request.env },
							stdio: ["pipe", "pipe", "pipe"],
						},
					),
			},
		});
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			processes,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const first = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			const sessionId = first.id;
			if (!sessionId) throw new Error("Remote session did not expose an id");
			const startedProcess = await first.startProcess("interactive-pty", { pty: true });
			await first.detach();
			await first.dispose();

			const second = await RemoteV2Session.open(client, sessionId, { mode: "control" });
			try {
				await second.writeProcess(startedProcess.processId, "hello\n");
				const completed = await second.waitProcess(startedProcess.processId);
				expect(completed).toMatchObject({ state: "exited", pty: true });
				expect(await second.readProcess(startedProcess.processId, 0)).toMatchObject({
					output: "pty:hello\n",
					cursor: Buffer.byteLength("pty:hello\n"),
					truncated: false,
				});
			} finally {
				await second.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
