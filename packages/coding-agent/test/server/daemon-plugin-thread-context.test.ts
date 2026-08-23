import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const threadText = "persistent plugin thread context";
const samplingText = "ephemeral plugin sampling context";

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon plugin thread context", () => {
	test("separates persistent thread context from request-only sampling", async () => {
		const result = await runPluginThreadContextScenario();
		expect(result.systemPrompt).toContain(threadText);
		expect(result.userMessages).toContain(samplingText);
		expect(result.transcript).not.toContain(threadText);
		expect(result.transcript).not.toContain(samplingText);
	});
});

async function runPluginThreadContextScenario(): Promise<{
	systemPrompt: string;
	userMessages: readonly string[];
	transcript: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-thread-context-"));
	directories.push(directory);
	const models = createModels();
	let systemPrompt = "";
	let userMessages: readonly string[] = [];
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-thread-context-faux",
		models: [
			{
				id: "coding-agent-daemon-plugin-thread-context-model",
				reasoning: false,
				contextWindow: 32_000,
				maxTokens: 1_000,
			},
		],
	});
	models.setProvider(faux.provider);
	faux.setResponses([
		(context: Context) => {
			systemPrompt = context.systemPrompt ?? "";
			userMessages = context.messages.flatMap((message) =>
				message.role === "user" && typeof message.content === "string" ? [message.content] : [],
			);
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
						thread: [{ id: "thread", slot: "developer_policy", position: "preamble", text: threadText }],
						sampling: [{ id: "sampling", slot: "contextual_user", position: "supplement", text: samplingText }],
					},
				},
			},
		});
		const created = await client.request({ command: "session/create", payload: { cwd: directory } });
		if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
		const sessionId = (created.result as { session: { id: string } }).session.id;
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		await client.request({ command: "turn/start", sessionId, payload: { text: "thread request" } });
		let transcript = "";
		for (let attempt = 0; attempt < 50; attempt++) {
			const snapshot = await client.request({ command: "session/read", sessionId });
			if (snapshot.ok && "result" in snapshot) {
				const session = (
					snapshot.result as unknown as { session: { phase: string; transcript: readonly unknown[] } }
				).session;
				if (session.phase === "idle") {
					transcript = JSON.stringify(session.transcript);
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return { systemPrompt, userMessages, transcript };
	} finally {
		client.dispose();
		await runtime.close();
	}
}
