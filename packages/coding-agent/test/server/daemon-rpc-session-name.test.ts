import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon server-default RPC session name", () => {
	test("rejects blank session names like the legacy RPC contract", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-session-name-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-rpc-session-name-faux",
			models: [{ id: "session-name-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const output: unknown[] = [];
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel()!,
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
			rpcInput: Readable.from(['{"id":"blank-name","type":"set_session_name","name":"   "}\n']),
			rpcOutput: (value) => output.push(value),
		});
		try {
			await runtime.cli.runRpc({ messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [] });
			expect(output).toContainEqual({
				id: "blank-name",
				type: "response",
				command: "set_session_name",
				success: false,
				error: "Session name cannot be empty",
			});
		} finally {
			await runtime.close();
		}
	});
});
