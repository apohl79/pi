import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { InMemoryV2ProcessRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon server-default RPC bash cancellation", () => {
	test("terminates the daemon-owned bash process and reports cancellation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-abort-bash-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-abort-bash-faux",
			models: [{ id: "rpc-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const input = new PassThrough();
		const output: unknown[] = [];
		const actions = new Map<string, () => void>([["abort_bash", () => input.end()]]);
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const processRegistry = new (class extends InMemoryV2ProcessRegistry {
			override async start(request: Parameters<InMemoryV2ProcessRegistry["start"]>[0]) {
				const process = await super.start(request);
				resolveStarted();
				return process;
			}
		})();
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			processes: processRegistry,
			write: () => {},
			rpcInput: input,
			rpcOutput: (value) => {
				output.push(value);
				actions.get(String((value as { command?: unknown }).command))?.();
			},
		});
		try {
			const runRpc = runtime.cli.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
			input.write('{"id":"bash-1","type":"bash","command":"sleep 30"}\n');
			await started;
			const readyAt = Date.now() + 50;
			await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(readyAt), { interval: 10, timeout: 1_000 });
			input.write('{"id":"abort-1","type":"abort_bash"}\n');
			await runRpc;
			expect(output).toContainEqual({ id: "abort-1", type: "response", command: "abort_bash", success: true });
			expect(output).toContainEqual({
				id: "bash-1",
				type: "response",
				command: "bash",
				success: true,
				data: expect.objectContaining({ cancelled: true, exitCode: 143 }),
			});
		} finally {
			await runtime.close();
		}
	});
});
