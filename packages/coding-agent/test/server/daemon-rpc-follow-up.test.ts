import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon server-default RPC follow-up", () => {
	test("preserves prompt follow-up behavior in the server-default RPC bridge", async () => {
		const fixture = await createFollowUpFixture();
		try {
			const runRpc = fixture.runtime.cli.runRpc({
				messages: [],
				fileArgs: [],
				unknownFlags: new Map(),
				diagnostics: [],
			});
			fixture.input.write('{"id":"prompt","type":"prompt","message":"start"}\n');
			await fixture.stateSeen;
			fixture.input.end();
			await runRpc;
			expect(fixture.output).toContainEqual(
				expect.objectContaining({
					id: "state-after-follow-up",
					command: "get_state",
				}),
			);
			expect(fixture.observedCalls.value).toBe(1);
		} finally {
			await fixture.runtime.close();
		}
	});
});

async function createFollowUpFixture(): Promise<{
	runtime: Awaited<ReturnType<typeof createConfiguredCodingAgentDaemonRuntime>>;
	input: PassThrough;
	output: unknown[];
	stateSeen: Promise<void>;
	observedCalls: { value: number };
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-follow-up-"));
	directories.push(directory);
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-rpc-follow-up-faux",
		models: [{ id: "rpc-follow-up-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	let release!: (response: ReturnType<typeof fauxAssistantMessage>) => void;
	faux.setResponses([
		() =>
			new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
				release = resolve;
			}),
	]);
	const input = new PassThrough();
	const output: unknown[] = [];
	const observedCalls = { value: 0 };
	let stateSeenResolve!: () => void;
	const stateSeen = new Promise<void>((resolve) => {
		stateSeenResolve = resolve;
	});
	const followUp = new Map([
		[
			"prompt",
			() => input.write('{"id":"follow-up-1","type":"prompt","message":"queued","streamingBehavior":"followUp"}\n'),
		],
		["follow-up-1", () => input.write('{"id":"state-after-follow-up","type":"get_state"}\n')],
		[
			"state-after-follow-up",
			() => {
				observedCalls.value = faux.state.callCount;
				release(fauxAssistantMessage("completed"));
				stateSeenResolve();
			},
		],
	]);
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { tools: [], activeToolNames: [] },
		write: () => {},
		rpcInput: input,
		rpcOutput: (value) => {
			output.push(value);
			const record = value as { id?: unknown; command?: unknown };
			followUp.get(String(record.id ?? record.command))?.();
		},
	});
	return { runtime, input, output, stateSeen, observedCalls };
}
