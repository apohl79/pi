import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon server-default RPC", () => {
	test("routes a JSON-RPC prompt through the configured daemon", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-default-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-default-faux",
			models: [{ id: "rpc-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("rpc response")]);
		const output: unknown[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			rpcInput: Readable.from(['{"id":"prompt-1","type":"prompt","message":"hello"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		try {
			await runtime.cli.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
			expect(output).toContainEqual({ id: "prompt-1", type: "response", command: "prompt", success: true });
		} finally {
			await runtime.close();
		}
	});

	test("applies server-default model and thinking options before RPC input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-options-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-options-faux",
			models: [
				{ id: "default-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "selected-model", reasoning: true, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const defaultModel = faux.getModel("default-model")!;
		const output: unknown[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: defaultModel,
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			rpcInput: Readable.from(['{"id":"state-1","type":"get_state"}\n']),
			rpcOutput: (value) => output.push(value),
		});
		try {
			await runtime.cli.runRpc({
				provider: "coding-agent-daemon-rpc-options-faux",
				model: "selected-model",
				thinking: "high",
				messages: [],
				fileArgs: [],
				unknownFlags: new Map(),
				diagnostics: [],
			});
			expect(output).toContainEqual({
				id: "state-1",
				type: "response",
				command: "get_state",
				success: true,
				data: expect.objectContaining({
					model: { provider: "coding-agent-daemon-rpc-options-faux", id: "selected-model" },
					thinkingLevel: "high",
				}),
			});
		} finally {
			await runtime.close();
		}
	});
});
