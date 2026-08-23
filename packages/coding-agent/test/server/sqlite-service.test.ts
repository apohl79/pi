import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { InMemoryV2AgentRegistry, InMemoryV2PluginRegistry, InMemoryV2UsageLedger } from "@earendil-works/pi-server";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import type { ServerRuntimeExtension } from "../../src/server/extension-host.ts";
import { ModelInstructionResolver } from "../../src/server/model-instructions.ts";
import { createCodingAgentV2SqliteService } from "../../src/server/sqlite-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("coding-agent SQLite v2 service", () => {
	test("persists server extension state across service reopen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-v2-extension-state-"));
		directories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-extension-state-faux",
			models: [{ id: "model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		let observed: unknown = "unset";
		const extension: ServerRuntimeExtension = {
			id: "state-check",
			onOperationAccepted: async (context) => {
				observed = await context.state.get("lastOperation");
				await context.state.set("lastOperation", context.operation.id);
			},
		};
		const createRepository = () =>
			new SqliteSessionRepository({
				env,
				sqlite: createNodeSqliteFactory(),
				databasePath: "sessions.sqlite",
			});
		const repository = createRepository();
		const service = await createCodingAgentV2SqliteService({
			repository,
			models,
			env,
			model: faux.getModel(),
			serverExtensions: [extension],
			harness: { tools: [], activeToolNames: [] },
		});
		try {
			const created = await service.createSession!({ id: "extension-state-session", cwd: directory });
			await created.runtime.run("operation-1", {
				command: "session/name/auto/set",
				sessionId: created.sessionId,
				payload: { enabled: true },
			});
			expect(observed).toBeUndefined();
			await repository.close();

			const reopenedRepository = createRepository();
			const reopened = await createCodingAgentV2SqliteService({
				repository: reopenedRepository,
				models,
				env,
				model: faux.getModel(),
				serverExtensions: [extension],
				harness: { tools: [], activeToolNames: [] },
			});
			const reopenedSession = await reopened.openSession("extension-state-session");
			await reopenedSession.run("operation-2", {
				command: "session/name/auto/set",
				sessionId: "extension-state-session",
				payload: { enabled: false },
			});
			expect(observed).toBe("operation-1");
			await reopenedRepository.close();
		} catch (error) {
			await repository.close().catch(() => {});
			throw error;
		}
	});

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
			models: [
				{ id: "coding-agent-v2-sqlite-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "coding-agent-v2-sqlite-small-model", reasoning: false, contextWindow: 16_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		expect(faux.getModel().id).toBe("coding-agent-v2-sqlite-model");
		const pluginRegistry = new InMemoryV2PluginRegistry();
		const agentRegistry = new InMemoryV2AgentRegistry();
		const usage = new InMemoryV2UsageLedger();
		await usage.record({
			responseId: "unknown-price",
			sessionId: "sqlite-session",
			agentId: "sqlite-session",
			operationId: "unknown-price",
			purpose: "agent",
			provider: faux.getModel().provider,
			model: faux.getModel().id,
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			pricing: "unknown",
			createdAt: Date.now(),
		});
		await pluginRegistry.addMarketplace("local", "file:///tmp/marketplace");
		await pluginRegistry.installPlugin({
			name: "snapshot-plugin",
			marketplace: "local",
			version: "1.0.0",
			manifest: { name: "snapshot-plugin", version: "1.0.0" },
		});
		const instructionResolver = new ModelInstructionResolver(
			[
				{
					id: "sqlite-profile",
					provider: faux.getModel().provider,
					model: "coding-agent-v2-sqlite-model",
					mode: "append",
					text: "Use SQLite fixtures.",
					applyTo: ["root"],
				},
				{
					id: "sqlite-child-profile",
					provider: faux.getModel().provider,
					model: "coding-agent-v2-sqlite-model",
					mode: "append",
					text: "Use child SQLite fixtures.",
					applyTo: ["subagent"],
				},
				{
					id: "sqlite-small-profile",
					provider: faux.getModel().provider,
					model: "coding-agent-v2-sqlite-small-model",
					mode: "append",
					text: "Use small-model fixtures.",
					applyTo: ["root"],
				},
			],
			{ cwd: directory },
		);
		expect(await instructionResolver.resolve(faux.getModel())).toMatchObject({ id: "sqlite-profile" });
		try {
			const service = await createCodingAgentV2SqliteService({
				repository,
				models,
				env,
				model: faux.getModel(),
				agentRoles: {
					reviewer: {
						instructions: "Review the requested change.",
						toolNames: ["read"],
						model: { provider: faux.getModel().provider, id: "coding-agent-v2-sqlite-small-model" },
					},
				},
				pluginRegistry,
				agentRegistry,
				usage,
				harness: {
					modelInstructions: {
						resolver: instructionResolver,
					},
					tools: [],
					activeToolNames: [],
				},
				compaction: (selectedModel) => ({
					enabled: true,
					reserveTokens: 123,
					keepRecentTokens: 789,
					modelOverrides: {
						[`${selectedModel.provider}/coding-agent-v2-sqlite-model`]: { reserveTokens: 123 },
						[`${selectedModel.provider}/coding-agent-v2-sqlite-small-model`]: { reserveTokens: 456 },
					},
				}),
			});
			const created = await service.createSession!({ id: "sqlite-session", cwd: directory, name: "SQLite session" });
			expect(created.sessionId).toBe("sqlite-session");
			expect((await created.runtime.snapshot()).compactionPolicy).toMatchObject({
				reserveTokens: 123,
				keepRecentTokens: 789,
				source: "mixed",
			});
			expect((await created.runtime.snapshot()).usage).toMatchObject({ pricingState: "unknown" });
			expect((await created.runtime.snapshot()).usage.costUsd).toBeUndefined();
			expect((await created.runtime.snapshot()).instructionProfile).toMatchObject({
				id: "sqlite-profile",
				source: "text",
				byteLength: "Use SQLite fixtures.".length,
				estimatedTokens: 5,
			});
			const child = await service.createSession!({
				id: "sqlite-child-session",
				parentSessionId: "sqlite-session",
				cwd: directory,
				role: "reviewer",
			});
			expect((await child.runtime.snapshot()).model).toMatchObject({ id: "coding-agent-v2-sqlite-small-model" });
			await usage.record({
				responseId: "child-usage",
				sessionId: child.sessionId,
				agentId: child.sessionId,
				operationId: "child-operation",
				purpose: "agent",
				provider: faux.getModel().provider,
				model: "coding-agent-v2-sqlite-small-model",
				input: 10,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				pricing: "catalog",
				costUsd: 0.01,
				createdAt: Date.now(),
			});
			expect((await created.runtime.snapshot()).usage).toMatchObject({
				input: 11,
				output: 5,
				pricingState: "unknown",
			});
			const transcriptBeforeModelSwitch = (await created.runtime.snapshot()).transcript;
			const enabledPluginSetHash = (await created.runtime.snapshot()).pluginSetHash;
			await pluginRegistry.setEnabled("snapshot-plugin@local", false);
			expect((await created.runtime.snapshot()).pluginSetHash).not.toBe(enabledPluginSetHash);
			await agentRegistry.spawn({
				sessionId: "sqlite-session",
				parentPath: "/sqlite-session",
				taskName: "research",
				taskMessage: "Inspect the fixtures",
				model: { provider: faux.getModel().provider, id: faux.getModel().id },
			});
			expect((await created.runtime.snapshot()).agents).toHaveLength(1);
			await created.runtime.run("model-switch", {
				command: "session/model/set",
				sessionId: "sqlite-session",
				payload: { provider: faux.getModel().provider, id: "coding-agent-v2-sqlite-small-model" },
			});
			expect((await created.runtime.snapshot()).compactionPolicy).toMatchObject({
				contextWindow: 16_000,
				reserveTokens: 456,
				keepRecentTokens: 789,
				source: "mixed",
			});
			expect((await created.runtime.snapshot()).instructionProfile).toMatchObject({
				id: "sqlite-small-profile",
				source: "text",
			});
			expect((await created.runtime.snapshot()).transcript).toEqual(transcriptBeforeModelSwitch);
			expect((await service.listSessions()).some((item) => item.id === "sqlite-session")).toBe(true);
			await service.openSession("sqlite-session");
			await service.deleteSession!(child.sessionId);
			await service.deleteSession!("sqlite-session");
			expect(await service.listSessions()).toEqual([]);
		} finally {
			await repository.close();
			await env.cleanup();
		}
	});

	test("preserves an explicitly configured root profile scope", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-coding-agent-v2-profile-scope-"));
		directories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const repository = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-profile-scope-faux",
			models: [{ id: "model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const resolver = new ModelInstructionResolver(
			[
				{
					id: "explicit-subagent-profile",
					provider: faux.getModel().provider,
					model: "model",
					mode: "append",
					text: "Explicit scope.",
					applyTo: ["subagent"],
				},
			],
			{ cwd: directory },
		);
		expect(await resolver.resolve({ provider: faux.getModel().provider, id: "model" }, "subagent")).toMatchObject({
			id: "explicit-subagent-profile",
		});
		try {
			const service = await createCodingAgentV2SqliteService({
				repository,
				models,
				env,
				model: faux.getModel(),
				harness: {
					modelInstructions: { resolver, scope: "subagent" },
					tools: [],
					activeToolNames: [],
				},
			});
			const created = await service.createSession!({ id: "explicit-scope-session", cwd: directory });
			expect((await created.runtime.snapshot()).instructionProfile).toMatchObject({
				id: "explicit-subagent-profile",
			});
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
			await created.runtime.run("disable-auto-name", {
				command: "session/name/auto/set",
				sessionId: created.sessionId,
				payload: { enabled: false },
			});
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
