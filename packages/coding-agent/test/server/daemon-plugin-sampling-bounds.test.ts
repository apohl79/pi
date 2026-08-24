import { mkdtemp, rm } from "node:fs/promises";
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

describe("coding-agent daemon plugin sampling bounds", () => {
	test("limits a plugin to 32 sampling entries before provider serialization", async () => {
		const result = await runSamplingBoundsScenario();
		expect(result.samplingMessages).toHaveLength(32);
		expect(result.samplingMessages[0]).toBe("entry-0");
		expect(result.samplingMessages[31]).toBe("entry-31");
	});
});

async function runSamplingBoundsScenario(): Promise<{ samplingMessages: readonly string[] }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-sampling-bounds-"));
	directories.push(directory);
	const models = createModels();
	const observedMessages: string[] = [];
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-sampling-bounds-faux",
		models: [
			{
				id: "coding-agent-daemon-plugin-sampling-bounds-model",
				reasoning: false,
				contextWindow: 32_000,
				maxTokens: 1_000,
			},
		],
	});
	models.setProvider(faux.provider);
	faux.setResponses([
		(context: Context) => {
			observedMessages.push(
				...context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				),
			);
			return fauxAssistantMessage("bounded response");
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
				name: "bounded-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "bounded-plugin",
					version: "1.0.0",
					context: {
						sampling: Array.from({ length: 40 }, (_, index) => ({
							id: `entry-${index}`,
							slot: "contextual_user",
							position: "supplement",
							text: `entry-${index}`,
						})),
					},
				},
			},
		});
		const created = await client.request({ command: "session/create", payload: { cwd: directory } });
		if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
		const sessionId = (created.result as { session: { id: string } }).session.id;
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		await client.request({ command: "turn/start", sessionId, payload: { text: "bounded request" } });
		for (let attempt = 0; attempt < 50; attempt++) {
			const snapshot = await client.request({ command: "session/read", sessionId });
			if (snapshot.ok && "result" in snapshot) {
				const phase = (snapshot.result as unknown as { session: { phase: string } }).session.phase;
				if (phase === "idle") break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return { samplingMessages: observedMessages.filter((message) => message.startsWith("entry-")) };
	} finally {
		client.dispose();
		await runtime.close();
	}
}
