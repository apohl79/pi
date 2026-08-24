import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "../../src/server/daemon-runtime.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production daemon compaction policy", () => {
	test("projects and toggles the configured policy over Unix v2", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-compaction-"));
		directories.push(directory);
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-daemon-compaction-faux",
			models: [
				{ id: "coding-agent-daemon-compaction-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: faux.getModel(),
			socketPath,
			compaction: () => ({ enabled: true, reserveTokens: 123, keepRecentTokens: 456 }),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				expect(session.snapshot?.compactionPolicy).toMatchObject({
					enabled: true,
					reserveTokens: 123,
					keepRecentTokens: 456,
					contextWindow: 32_000,
				});
				const operationId = await session.setAutoCompaction(false);
				await session.waitForOperation(operationId);
				expect(session.snapshot?.compactionPolicy).toMatchObject({ enabled: false, reserveTokens: 123 });
				expect((await session.readOperation(operationId)).state).toBe("complete");
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});

	test("preflights target-model compaction before sampling after a root switch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-daemon-compaction-model-switch-"));
		directories.push(directory);
		const models = createModels();
		const rootFaux = fauxProvider({
			provider: "coding-agent-daemon-compaction-switch-faux",
			models: [
				{ id: "large-root-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "small-child-model", reasoning: false, contextWindow: 100, maxTokens: 1_000 },
			],
		});
		const childFaux = fauxProvider({
			provider: "coding-agent-daemon-compaction-child-faux",
			models: [{ id: "small-child-model", reasoning: false, contextWindow: 100, maxTokens: 1_000 }],
		});
		models.setProvider(rootFaux.provider);
		models.setProvider(childFaux.provider);
		const largeResponse = {
			...fauxAssistantMessage("large root response"),
			usage: { ...fauxAssistantMessage("large root response").usage, input: 100, totalTokens: 100 },
		};
		rootFaux.setResponses([
			largeResponse,
			fauxAssistantMessage("target-model compaction summary"),
			fauxAssistantMessage("small root response"),
		]);
		childFaux.setResponses([fauxAssistantMessage("child response")]);
		const socketPath = join(directory, "server.sock");
		const runtime = await createConfiguredCodingAgentDaemonRuntime({
			agentDir: directory,
			cwd: directory,
			models,
			model: rootFaux.getModel("large-root-model")!,
			socketPath,
			compaction: (model) => ({
				enabled: true,
				reserveTokens: model.id === "small-child-model" ? 99 : 100,
				keepRecentTokens: 1,
			}),
			harness: { tools: [], activeToolNames: [] },
			write: () => {},
		});
		const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
		try {
			await runtime.daemon.start();
			await client.connect();
			const session = await RemoteV2Session.create(client, { cwd: directory }, { mode: "control" });
			try {
				const firstOperation = await session.submit("fill the large root context");
				await session.waitForOperation(firstOperation);
				const rootCallsAfterFirstOperation = rootFaux.state.callCount;
				const child = await session.spawnAgent("small-child", "use the small child model", {
					model: { provider: "coding-agent-daemon-compaction-child-faux", id: "small-child-model" },
				});
				expect(child.model).toEqual({
					provider: "coding-agent-daemon-compaction-child-faux",
					id: "small-child-model",
				});
				const childCallsAfterSpawn = childFaux.state.callCount;
				const switchOperation = await session.setModel({
					provider: "coding-agent-daemon-compaction-switch-faux",
					id: "small-child-model",
				});
				await session.waitForOperation(switchOperation);
				expect(rootFaux.state.callCount).toBe(rootCallsAfterFirstOperation + 1);
				expect(childFaux.state.callCount).toBe(childCallsAfterSpawn);
				expect(session.snapshot?.model).toEqual({
					provider: "coding-agent-daemon-compaction-switch-faux",
					id: "small-child-model",
				});
				const secondOperation = await session.submit("continue after target compaction");
				await session.waitForOperation(secondOperation);
				expect(rootFaux.state.callCount).toBe(rootCallsAfterFirstOperation + 2);
				expect((await session.listAgents())[0]?.model).toEqual({
					provider: "coding-agent-daemon-compaction-child-faux",
					id: "small-child-model",
				});
			} finally {
				await session.dispose();
			}
		} finally {
			client.dispose();
			await runtime.close();
		}
	});
});
