import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const samplingText = "inherited plugin context";

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent daemon child plugin sampling", () => {
	test("inherits the active plugin sampling entry exactly once in a child request", async () => {
		const result = await runChildSamplingScenario();
		expect(result.waited).toMatchObject({ ok: true, result: { agent: { state: "complete" } } });
		expect(result.observedMessages.filter((message) => message === samplingText)).toHaveLength(1);
	});
});

async function runChildSamplingScenario(): Promise<{ waited: unknown; observedMessages: readonly string[] }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-child-sampling-"));
	directories.push(directory);
	const observedMessages: string[] = [];
	const models = createModels();
	const parent = fauxProvider({
		provider: "coding-agent-daemon-plugin-parent-faux",
		models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	const child = fauxProvider({
		provider: "coding-agent-daemon-plugin-child-faux",
		models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(parent.provider);
	models.setProvider(child.provider);
	const childResponse = (context: Context) => {
		observedMessages.push(
			...context.messages.flatMap((message) =>
				message.role === "user" && typeof message.content === "string" ? [message.content] : [],
			),
		);
		return fauxAssistantMessage("child response");
	};
	child.setResponses([childResponse]);
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: parent.getModel(),
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
				name: "child-context-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "child-context-plugin",
					version: "1.0.0",
					context: {
						sampling: [{ id: "context", slot: "contextual_user", position: "supplement", text: samplingText }],
					},
				},
			},
		});
		const created = await client.request({ command: "session/create", payload: { cwd: directory } });
		if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
		const sessionId = (created.result as { session: { id: string } }).session.id;
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		const spawned = await client.request({
			command: "agent/spawn",
			sessionId,
			payload: {
				taskName: "context-specialist",
				taskMessage: "use inherited context",
				model: { provider: "coding-agent-daemon-plugin-child-faux", id: "child-model" },
			},
		});
		if (!spawned.ok || !("result" in spawned)) throw new Error("Child spawn failed");
		const agentId = (spawned.result as { agent: { id: string } }).agent.id;
		const waited = await client.request({ command: "agent/wait", payload: { agentId } });
		return { waited, observedMessages };
	} finally {
		client.dispose();
		await runtime.close();
	}
}
