import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon server-default RPC model cycle", () => {
	test("waits for RPC model cycles before acknowledging them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-model-cycle-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-model-cycle-faux",
			models: [
				{ id: "first-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "second-model", reasoning: true, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const input = new PassThrough();
		const output: unknown[] = [];
		const actions = new Map<string, () => void>([
			["cycle_model", () => input.write('{"id":"state-after-cycle","type":"get_state"}\n')],
			["get_state", () => input.end()],
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel("first-model")!,
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			rpcInput: input,
			rpcOutput: (value) => {
				output.push(value);
				actions.get(String((value as { command?: unknown }).command))?.();
			},
		});
		try {
			const runRpc = runtime.cli.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
			input.write('{"id":"cycle-model","type":"cycle_model"}\n');
			await runRpc;
			expect(output).toContainEqual(
				expect.objectContaining({
					id: "state-after-cycle",
					command: "get_state",
					data: expect.objectContaining({
						model: { provider: "coding-agent-daemon-rpc-model-cycle-faux", id: "second-model" },
					}),
				}),
			);
		} finally {
			await runtime.close();
		}
	});
});
