import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const samplingText = "request-only plugin context";

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function waitForTurn(client: PiClientV2, sessionId: string, operationId: string): Promise<readonly unknown[]> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const operation = await client.request({ command: "operation/read", operationId });
		if (operation.ok && "result" in operation) {
			const state = (operation.result as { operation: { state: string } }).operation.state;
			if (state === "failed")
				throw new Error(
					`Plugin sampling turn failed: ${(operation.result as { operation: { error?: string } }).operation.error ?? "unknown"}`,
				);
			if (state === "complete") {
				const completed = await client.request({ command: "session/read", sessionId });
				if (completed.ok && "result" in completed)
					return (completed.result as unknown as { session: { transcript: readonly unknown[] } }).session
						.transcript;
			}
		}
		const snapshot = await client.request({ command: "session/read", sessionId });
		if (snapshot.ok && "result" in snapshot) {
			const session = (snapshot.result as unknown as { session: { phase: string; transcript: readonly unknown[] } })
				.session;
			if (session.phase === "failed") throw new Error("Plugin sampling turn failed");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for plugin sampling turn");
}

async function runTurns(client: PiClientV2, sessionId: string, count: number): Promise<readonly unknown[]> {
	let transcript: readonly unknown[] = [];
	for (let turn = 0; turn < count; turn++) {
		const accepted = await client.request({ command: "turn/start", sessionId, payload: { text: `request ${turn}` } });
		if (!accepted.ok || !("accepted" in accepted)) throw new Error("Plugin sampling turn was not accepted");
		transcript = await waitForTurn(client, sessionId, accepted.accepted.operationId);
	}
	return transcript;
}

describe("coding-agent daemon plugin sampling durability", () => {
	test("keeps request-only sampling out of 100 persisted turns", async () => {
		const result = await runSamplingDurabilityScenario();
		expect(result.observedRequests).toHaveLength(100);
		expect(result.observedRequests.every((messages) => messages.includes(samplingText))).toBe(true);
		expect(JSON.stringify(result.transcript)).not.toContain(samplingText);
		expect(result.transcript).toHaveLength(200);
	}, 120_000);
});

async function runSamplingDurabilityScenario(): Promise<{
	observedRequests: readonly (readonly string[])[];
	transcript: readonly unknown[];
}> {
	const directory = await mkdtemp(join(tmpdir(), "pi-daemon-plugin-sampling-"));
	directories.push(directory);
	const observedRequests: string[][] = [];
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-plugin-sampling-faux",
		models: [
			{
				id: "coding-agent-daemon-plugin-sampling-model",
				reasoning: false,
				contextWindow: 200_000,
				maxTokens: 1_000,
			},
		],
	});
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 100 }, () => (context: Context) => {
			observedRequests.push(
				context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				),
			);
			return fauxAssistantMessage("sampling response");
		}),
	);
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
				name: "context-plugin",
				marketplace: "local",
				version: "1.0.0",
				manifest: {
					name: "context-plugin",
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
		await client.request({ command: "session/name/auto/set", sessionId, payload: { enabled: false } });
		const transcript = await runTurns(client, sessionId, 100);
		return { observedRequests, transcript };
	} finally {
		client.dispose();
		await runtime.close();
	}
}
