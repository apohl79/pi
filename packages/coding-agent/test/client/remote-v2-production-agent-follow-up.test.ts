import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2InteractiveAttachment, RemoteV2SessionSelector } from "../../src/index.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production remote v2 agent follow-up", () => {
	test("routes /agent-follow-up through the daemon child graph", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-remote-agent-follow-up-"));
		directories.push(directory);
		const models = createModels();
		const parent = fauxProvider({
			provider: "coding-agent-remote-agent-parent-faux",
			models: [{ id: "parent-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		const child = fauxProvider({
			provider: "coding-agent-remote-agent-child-faux",
			models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(parent.provider);
		models.setProvider(child.provider);
		child.setResponses([fauxAssistantMessage("child completed"), fauxAssistantMessage("child follow-up completed")]);
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
			const created = await client.request({ command: "session/create", payload: { cwd: directory } });
			const sessionId = (created as unknown as { result: { session: { id: string } } }).result.session.id;
			const attachment = await new RemoteV2SessionSelector(client).attachView(sessionId, { mode: "control" });
			const adapter = new RemoteV2InteractiveAttachment(attachment);
			try {
				const agent = await attachment.session.spawnAgent("review", "review the change", {
					model: { provider: "coding-agent-remote-agent-child-faux", id: "child-model" },
				});
				await attachment.session.waitAgent(agent.id);
				expect(await adapter.execute(`/agent-follow-up ${agent.id} revisit the review`)).toEqual({
					kind: "status",
					text: "agent complete",
				});
			} finally {
				await adapter.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
