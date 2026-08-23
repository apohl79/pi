import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon plugin thread conditions", () => {
	test("evaluates condition_shell before injecting thread context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-thread-condition-"));
		directories.push(directory);
		const marker = join(directory, "thread-enabled");
		const models = createModels();
		let systemPrompts: string[] = [];
		const faux = fauxProvider({
			provider: "coding-agent-daemon-plugin-thread-condition-faux",
			models: [
				{
					id: "coding-agent-daemon-plugin-thread-condition-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			(context: Context) => {
				systemPrompts = [...systemPrompts, context.systemPrompt ?? ""];
				return fauxAssistantMessage("thread response");
			},
			(context: Context) => {
				systemPrompts = [...systemPrompts, context.systemPrompt ?? ""];
				return fauxAssistantMessage("thread response");
			},
		]);
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath: join(directory, "server.sock"),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			await client.request({
				command: "marketplace/add",
				payload: { name: "local", source: "file:///tmp/marketplace" },
			});
			await client.request({
				command: "plugin/install",
				payload: {
					name: "thread-plugin",
					marketplace: "local",
					version: "1.0.0",
					manifest: {
						name: "thread-plugin",
						version: "1.0.0",
						context: {
							thread: [
								{
									id: "thread",
									slot: "developer_policy",
									position: "preamble",
									text: "conditional thread context",
									condition_shell: "test -f thread-enabled",
								},
							],
						},
					},
				},
			});
			await writeFile(marker, "enabled");
			const enabledSession = await createSession(client, directory);
			await startAndWait(client, enabledSession, "enabled");
			await rm(marker);
			const disabledSession = await createSession(client, directory);
			await startAndWait(client, disabledSession, "disabled");
			expect(systemPrompts[0]).toContain("conditional thread context");
			expect(systemPrompts[1]).not.toContain("conditional thread context");
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function createSession(client: PiClientV2, directory: string): Promise<string> {
	const created = await client.request({ command: "session/create", payload: { cwd: directory } });
	if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
	const sessionId = (created.result as { session: { id: string } }).session.id;
	await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
	return sessionId;
}

async function startAndWait(client: PiClientV2, sessionId: string, text: string): Promise<void> {
	await client.request({ command: "turn/start", sessionId, payload: { text } });
	for (let attempt = 0; attempt < 50; attempt++) {
		const snapshot = await client.request({ command: "session/read", sessionId });
		if (
			snapshot.ok &&
			"result" in snapshot &&
			(snapshot.result as { session: { phase: string } }).session.phase === "idle"
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Session ${sessionId} did not become idle`);
}
