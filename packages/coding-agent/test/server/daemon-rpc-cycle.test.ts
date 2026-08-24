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

describe("production daemon server-default RPC cycles", () => {
	test("waits for RPC thinking cycles before acknowledging them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-thinking-cycle-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-thinking-cycle-faux",
			models: [{ id: "cycle-model", reasoning: true, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const input = new PassThrough();
		const output: unknown[] = [];
		const actions = new Map<string, () => void>([
			["cycle_thinking_level", () => input.write('{"id":"state-after-cycle","type":"get_state"}\n')],
			["get_state", () => input.end()],
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel()!,
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
			const runRpc = runtime.cli.runRpc({
				thinking: "medium",
				messages: [],
				fileArgs: [],
				unknownFlags: new Map(),
				diagnostics: [],
			});
			input.write('{"id":"cycle-thinking","type":"cycle_thinking_level"}\n');
			await runRpc;
			expect(output).toContainEqual(
				expect.objectContaining({
					id: "state-after-cycle",
					command: "get_state",
					data: expect.objectContaining({ thinkingLevel: "high" }),
				}),
			);
		} finally {
			await runtime.close();
		}
	});
});
