import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { NodeV2ProcessRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function resultOf<T>(value: unknown): T {
	return (value as { result: T }).result;
}

async function createPtyRuntime(
	directory: string,
	socketPath: string,
	processScript = "process.stdin.once('data', d => { process.stdout.write('pty:' + d); process.exit(0); })",
) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-pty-faux",
		models: [{ id: "pty-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	const processes = new NodeV2ProcessRegistry({
		ptyLauncher: {
			spawn: (request) =>
				spawn(process.execPath, ["-e", processScript], {
					cwd: request.cwd,
					env: { ...process.env, ...request.env },
					stdio: ["pipe", "pipe", "pipe"],
				}),
		},
	});
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath,
		processes,
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
	});
}

async function startPty(client: PiClientV2, sessionId: string): Promise<string> {
	const started = await client.request({
		command: "process/start",
		sessionId,
		payload: { command: "interactive-pty", pty: true },
	});
	return resultOf<{ process: { processId: string } }>(started).process.processId;
}

async function assertTerminalResult(client: PiClientV2, sessionId: string, processId: string): Promise<void> {
	const waited = await client.request({ command: "process/wait", sessionId, payload: { processId } });
	expect(waited).toMatchObject({ result: { process: { state: "exited" } } });
	const output = await client.request({ command: "process/read", sessionId, payload: { processId, cursor: 0 } });
	expect(output).toMatchObject({
		result: { output: { output: "pty:hello\n", cursor: 10, truncated: false } },
	});
	expect(
		await client.request({ command: "process/read", sessionId, payload: { processId, cursor: 10 } }),
	).toMatchObject({ result: { output: { output: "", cursor: 10, truncated: false } } });
}

describe("coding-agent daemon PTY detach and reattach", () => {
	test("writes detached PTY input and reads the terminal result once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-pty-reattach-"));
		directories.push(directory);
		const socketPath = join(directory, "server.sock");
		const runtime = await createPtyRuntime(directory, socketPath);
		const firstClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await firstClient.connect();
			const sessionId = resultOf<{ session: { id: string } }>(
				await firstClient.request({ command: "session/create", payload: { cwd: directory } }),
			).session.id;
			await firstClient.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const processId = await startPty(firstClient, sessionId);
			await firstClient.request({ command: "session/detach", sessionId });
			firstClient.dispose();

			const secondClient = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
			try {
				await secondClient.connect();
				await secondClient.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
				await secondClient.request({
					command: "process/write",
					sessionId,
					payload: { processId, input: "hello\n" },
				});
				await assertTerminalResult(secondClient, sessionId, processId);
			} finally {
				secondClient.dispose();
			}
		} finally {
			firstClient.dispose();
			await runtime.close();
		}
	});

	test("closes PTY input through the production daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-pty-eof-"));
		directories.push(directory);
		const socketPath = join(directory, "server.sock");
		const runtime = await createPtyRuntime(
			directory,
			socketPath,
			"process.stdin.on('data', d => process.stdout.write('pty:' + d)); process.stdin.on('end', () => { process.stdout.write(':eof'); process.exit(0); })",
		);
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const sessionId = resultOf<{ session: { id: string } }>(
				await client.request({ command: "session/create", payload: { cwd: directory } }),
			).session.id;
			await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
			const processId = await startPty(client, sessionId);
			await client.request({
				command: "process/write",
				sessionId,
				payload: { processId, input: "hello", eof: true },
			});
			await expect(
				client.request({ command: "process/wait", sessionId, payload: { processId } }),
			).resolves.toMatchObject({
				result: { process: { state: "exited" } },
			});
			expect(
				await client.request({ command: "process/read", sessionId, payload: { processId, cursor: 0 } }),
			).toMatchObject({
				result: { output: { output: "pty:hello:eof", cursor: 13, truncated: false } },
			});
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
