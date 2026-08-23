import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 usage", () => {
	test("reads identity-keyed usage and known cost through the remote client", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-usage-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-remote-usage-faux",
			models: [
				{
					id: "remote-usage-model",
					reasoning: false,
					contextWindow: 32_000,
					maxTokens: 1_000,
					cost: { input: 0, output: 0.25, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			{
				...fauxAssistantMessage("usage response"),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
			},
		]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				if (session.id === undefined) throw new Error("Created remote session has no id");
				const operationId = await session.submit("measure remote usage");
				await session.waitForOperation(operationId);
				const usage = await session.readUsage({ sessionId: session.id });
				expect(usage.entries).toHaveLength(1);
				expect(usage.aggregate).toMatchObject({ responses: 1, costUsd: 0.25, pricingState: "known" });
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
