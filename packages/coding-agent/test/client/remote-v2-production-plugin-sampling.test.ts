import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { InMemoryV2PluginRegistry } from "@earendil-works/pi-server";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];
const samplingText = "request-only remote plugin context";

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 plugin sampling", () => {
	test("changes only the next provider request and never grows transcript history", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-plugin-sampling-"));
		directories.push(directory);
		const marker = join(directory, "sampling-enabled");
		await writeFile(marker, "enabled");
		const requests: string[][] = [];
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-plugin-sampling-faux",
			models: [{ id: "remote-plugin-sampling-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const response = (context: Context) => {
			requests.push(
				context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				),
			);
			return fauxAssistantMessage("sampling response");
		};
		faux.setResponses([response, response]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			pluginRegistry: new InMemoryV2PluginRegistry(),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				await complete(session, await session.setAutoName(false));
				await session.addMarketplace("local", "/workspace/plugins");
				await session.installPlugin({
					name: "context-plugin",
					marketplace: "local",
					version: "1.0.0",
					manifest: {
						name: "context-plugin",
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
				});
				await complete(session, await session.submit("enabled request"));
				await unlink(marker);
				await complete(session, await session.submit("disabled request"));
				expect(requests).toHaveLength(2);
				expect(requests[0]).toContain(samplingText);
				expect(requests[1]).not.toContain(samplingText);
				expect(JSON.stringify(session.snapshot?.transcript)).not.toContain(samplingText);
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});

async function complete(session: RemoteV2Session, operationId: string): Promise<void> {
	await session.waitForOperation(operationId);
	expect((await session.readOperation(operationId)).state).toBe("complete");
}
