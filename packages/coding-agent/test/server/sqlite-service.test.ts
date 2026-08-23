import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { InMemoryV2PluginRegistry } from "@earendil-works/pi-server";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { createCodingAgentV2SqliteService } from "../../src/server/sqlite-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent SQLite v2 service", () => {
	test("creates, lists, lazily opens, and deletes a durable session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-v2-sqlite-"));
		directories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const repository = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-sqlite-faux",
			models: [{ id: "coding-agent-v2-sqlite-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		try {
			const service = await createCodingAgentV2SqliteService({
				repository,
				models,
				env,
				model: faux.getModel(),
				compaction: (selectedModel) => ({
					enabled: true,
					reserveTokens: selectedModel.id === "coding-agent-v2-sqlite-model" ? 123 : 456,
					keepRecentTokens: 789,
				}),
				harness: { tools: [], activeToolNames: [] },
			});
			const created = await service.createSession!({ id: "sqlite-session", cwd: directory, name: "SQLite session" });
			expect(created.sessionId).toBe("sqlite-session");
			expect((await created.runtime.snapshot()).compactionPolicy).toMatchObject({
				reserveTokens: 123,
				keepRecentTokens: 789,
			});
			expect(await service.listSessions()).toMatchObject([{ id: "sqlite-session", sessionName: "SQLite session" }]);
			await service.openSession("sqlite-session");
			await service.deleteSession!("sqlite-session");
			expect(await service.listSessions()).toEqual([]);
		} finally {
			await repository.close();
			await env.cleanup();
		}
	});

	test("injects enabled plugin sampling into provider requests", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-v2-plugin-sampling-"));
		directories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const repository = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		const models = createModels();
		const observedRequests: string[][] = [];
		const faux = fauxProvider({
			provider: "coding-agent-v2-plugin-sampling-faux",
			models: [
				{ id: "coding-agent-v2-plugin-sampling-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			(context) => {
				observedRequests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				return fauxAssistantMessage("done");
			},
		]);
		const pluginRegistry = new InMemoryV2PluginRegistry();
		await pluginRegistry.addMarketplace("local", directory);
		await pluginRegistry.installPlugin({
			name: "context",
			marketplace: "local",
			version: "1",
			manifest: {
				context: {
					sampling: [{ id: "reminder", slot: "contextual_user", position: "supplement", text: "plugin reminder" }],
				},
			},
		});
		try {
			const service = await createCodingAgentV2SqliteService({
				repository,
				models,
				env,
				model: faux.getModel(),
				pluginRegistry,
				harness: { tools: [], activeToolNames: [] },
			});
			const created = await service.createSession!({ id: "plugin-sampling-session", cwd: directory });
			await created.runtime.run("plugin-sampling-turn", {
				command: "turn/start",
				sessionId: created.sessionId,
				payload: { text: "work" },
			});
			expect(observedRequests[0]).toContain("plugin reminder");
			await pluginRegistry.installPlugin({
				name: "next-context",
				marketplace: "local",
				version: "1",
				manifest: {
					context: {
						sampling: [{ id: "next", slot: "contextual_user", position: "supplement", text: "next reminder" }],
					},
				},
			});
			faux.appendResponses([
				(context) => {
					observedRequests.push(
						context.messages.flatMap((message) =>
							message.role === "user" && typeof message.content === "string" ? [message.content] : [],
						),
					);
					return fauxAssistantMessage("done again");
				},
			]);
			await created.runtime.run("plugin-sampling-turn-2", {
				command: "turn/start",
				sessionId: created.sessionId,
				payload: { text: "work again" },
			});
			expect(observedRequests[1]).toContain("next reminder");
		} finally {
			await repository.close();
			await env.cleanup();
		}
	});
});
