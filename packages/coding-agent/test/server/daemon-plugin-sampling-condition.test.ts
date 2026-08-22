import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const samplingText = "conditional plugin context";

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function waitForTurn(client: PiClientV2, sessionId: string): Promise<readonly unknown[]> {
	let active = false;
	for (let attempt = 0; attempt < 50; attempt++) {
		const snapshot = await client.request({ command: "session/read", sessionId });
		if (snapshot.ok && "result" in snapshot) {
			const session = (snapshot.result as unknown as { session: { phase: string; transcript: readonly unknown[] } })
				.session;
			active ||= session.phase !== "idle";
			if (active && session.phase === "idle") return session.transcript;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for conditional sampling turn");
}

describe("coding-agent daemon plugin sampling conditions", () => {
	test("changes the next provider request when its execution condition changes", async () => {
		const result = await runConditionalSamplingScenario();
		expect(result.observedRequests).toEqual([
			expect.arrayContaining([samplingText]),
			expect.not.arrayContaining([samplingText]),
		]);
		expect(JSON.stringify(result.transcript)).not.toContain(samplingText);
		expect(result.diagnostics).toMatchObject({
			ok: true,
			result: {
				events: expect.arrayContaining([
					expect.objectContaining({
						kind: "plugin_sampling",
						payload: expect.objectContaining({
							pluginId: "conditional-plugin@local",
							reason: "condition_failed",
						}),
					}),
				]),
			},
		});
	}, 60_000);
});

async function runConditionalSamplingScenario(): Promise<{
	observedRequests: readonly (readonly string[])[];
	transcript: readonly unknown[];
	diagnostics: unknown;
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-sampling-condition-"));
	directories.push(directory);
	const marker = join(directory, "sampling-enabled");
	await writeFile(marker, "enabled");
	const observedRequests: string[][] = [];
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-sampling-condition-faux",
		models: [
			{
				id: "coding-agent-daemon-plugin-sampling-condition-model",
				reasoning: false,
				contextWindow: 32_000,
				maxTokens: 1_000,
			},
		],
	});
	models.setProvider(faux.provider);
	const response = (context: Context) => {
		observedRequests.push(
			context.messages.flatMap((message) =>
				message.role === "user" && typeof message.content === "string" ? [message.content] : [],
			),
		);
		return fauxAssistantMessage("conditional response");
	};
	faux.setResponses([response, response]);
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
				name: "conditional-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "conditional-plugin",
					version: "1.0.0",
					context: {
						sampling: [
							{
								id: "context",
								slot: "contextual_user",
								position: "supplement",
								text: samplingText,
								condition_shell: "test -f sampling-enabled",
							},
						],
					},
				},
			},
		});
		const created = await client.request({ command: "session/create", payload: { cwd: directory } });
		if (!created.ok || !("result" in created)) throw new Error("Session creation failed");
		const sessionId = (created.result as { session: { id: string } }).session.id;
		await client.request({ command: "session/attach", sessionId, payload: { mode: "control" } });
		await client.request({ command: "session/name/auto/set", sessionId, payload: { enabled: false } });
		await client.request({ command: "turn/start", sessionId, payload: { text: "enabled request" } });
		await waitForTurn(client, sessionId);
		await unlink(marker);
		await client.request({ command: "turn/start", sessionId, payload: { text: "disabled request" } });
		const transcript = await waitForTurn(client, sessionId);
		const diagnostics = await client.request({ command: "diagnostics/timeline", payload: { sessionId } });
		return { observedRequests, transcript, diagnostics };
	} finally {
		client.dispose();
		await runtime.close();
	}
}
