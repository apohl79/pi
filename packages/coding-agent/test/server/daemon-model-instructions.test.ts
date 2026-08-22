import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";
import { ModelInstructionResolver } from "../../src/server/model-instructions.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createModelInstructionFixture(directory: string, rootPrompts: string[], childPrompts: string[]) {
	const models = createModels();
	const root = fauxProvider({
		provider: "coding-agent-model-instructions-root-faux",
		models: [{ id: "root-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	const child = fauxProvider({
		provider: "coding-agent-model-instructions-child-faux",
		models: [{ id: "child-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
	});
	root.setResponses([
		(context) => {
			rootPrompts.push(context.systemPrompt ?? "");
			return fauxAssistantMessage("root response");
		},
	]);
	child.setResponses([
		(context) => {
			childPrompts.push(context.systemPrompt ?? "");
			return fauxAssistantMessage("child response");
		},
	]);
	models.setProvider(root.provider);
	models.setProvider(child.provider);
	const resolver = new ModelInstructionResolver(
		[
			{
				id: "root-profile",
				provider: root.provider.id,
				model: "root-model",
				mode: "append",
				text: "Root profile only.",
			},
			{
				id: "child-profile",
				provider: child.provider.id,
				model: "child-model",
				mode: "append",
				text: "Child profile only.",
			},
		],
		{ cwd: directory },
	);
	const socketPath = join(directory, "server.sock");
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir: directory,
		cwd: directory,
		models,
		model: root.getModel(),
		socketPath,
		harness: { tools: [], activeToolNames: [], modelInstructions: { resolver } },
		write: () => {},
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	await runtime.daemon.start();
	await client.connect();
	return { runtime, client, child };
}

describe("production daemon model instruction profiles", () => {
	test("resolves root and child profiles independently in provider requests", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-model-instructions-"));
		directories.push(directory);
		const rootPrompts: string[] = [];
		const childPrompts: string[] = [];
		const { runtime, client, child } = await createModelInstructionFixture(directory, rootPrompts, childPrompts);
		try {
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const rootOperation = await session.submit("root request");
				await session.waitForOperation(rootOperation);
				const childAgent = await session.spawnAgent("child", "child request", {
					model: { provider: child.provider.id, id: "child-model" },
				});
				await session.waitAgent(childAgent.id);
				expect(rootPrompts).toHaveLength(1);
				expect(rootPrompts[0]).toContain("Root profile only.");
				expect(rootPrompts[0]).not.toContain("Child profile only.");
				expect(childPrompts).toHaveLength(1);
				expect(childPrompts[0]).toContain("Child profile only.");
				expect(childPrompts[0]).not.toContain("Root profile only.");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
