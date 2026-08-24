import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { AdapterV2WebService } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createWebRuntime(directory: string) {
	const models = createModels();
	const faux = fauxProvider({
		provider: "coding-agent-daemon-web-tool-faux",
		models: [{ id: "coding-agent-daemon-web-tool-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("web", { operation: "search_query", query: "configured result" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("web result received"),
	]);
	return createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: faux.getModel(),
		socketPath: join(directory, "server.sock"),
		harness: { activeToolNames: ["web"] },
		web: new AdapterV2WebService({
			execute: async (request) => [
				{
					id: "configured-result",
					title: request.query ?? request.operation,
					source: "configured-web-adapter",
					retrievedAt: 1,
					url: "https://example.test/configured",
					extract: "configured web extract",
				},
			],
		}),
		write: () => {},
	});
}

describe("production daemon web tool", () => {
	test("routes a model web tool call through the configured adapter", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-web-tool-"));
		directories.push(directory);
		const runtime = await createWebRuntime(directory);
		const client = new PiClientV2({
			transportFactory: createUnixTransportFactory({ path: join(directory, "server.sock") }),
		});
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const operationId = await session.submit("find the configured result");
				const snapshot = await session.waitForOperation(operationId);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "tool" &&
							item.content.some((part) => part.type === "text" && part.text.includes("configured web extract")),
					),
				).toBe(true);
				expect(
					snapshot.transcript.some(
						(item) =>
							item.role === "assistant" &&
							item.content.some((part) => part.type === "text" && part.text === "web result received"),
					),
				).toBe(true);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
