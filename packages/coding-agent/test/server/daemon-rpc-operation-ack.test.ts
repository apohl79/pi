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

describe("production daemon server-default RPC operation acknowledgement", () => {
	test("waits for RPC model changes before acknowledging them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-model-command-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-model-command-faux",
			models: [
				{ id: "default-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "selected-model", reasoning: true, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const input = new PassThrough();
		const output: unknown[] = [];
		const actions = new Map<string, () => void>([
			["set_model", () => input.write('{"id":"state-after-model","type":"get_state"}\n')],
			["get_state", () => input.end()],
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel("default-model")!,
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
			input.write(
				'{"id":"set-model","type":"set_model","provider":"coding-agent-daemon-rpc-model-command-faux","modelId":"selected-model"}\n',
			);
			await runRpc;
			expect(output).toContainEqual(
				expect.objectContaining({
					id: "state-after-model",
					command: "get_state",
					data: expect.objectContaining({
						model: { provider: "coding-agent-daemon-rpc-model-command-faux", id: "selected-model" },
					}),
				}),
			);
		} finally {
			await runtime.close();
		}
	});
});
