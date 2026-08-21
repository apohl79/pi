import { GoalManager, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import { SessionSnapshotV2Schema } from "@earendil-works/pi-protocol";
import { createCodingAgentHarness } from "../../src/server/create-harness.ts";
import { ServerRuntimeExtensionHost } from "../../src/server/extension-host.ts";
import { createCodingAgentV2Service } from "../../src/server/v2-service.ts";

describe("coding-agent v2 service adapter", () => {
	test("generates a bounded provider-backed name without overwriting an explicit name", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-naming-faux",
			models: [{ id: "coding-agent-v2-naming-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("turn response"), fauxAssistantMessage("Fix durable session resume")]);
		const session = new Session(new InMemorySessionStorage({ id: "naming-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
			systemPrompt: "naming",
		});
		try {
			const service = createCodingAgentV2Service(
				models,
				[{ metadata: { id: "naming-session", createdAt: 1, updatedAt: 1 }, harness: created.harness }],
				{ fastModel: faux.getModel() },
			);
			const runtime = await service.openSession("naming-session");
			await runtime.run("name-turn", {
				command: "turn/start",
				sessionId: "naming-session",
				payload: { text: "resume work" },
			});
			expect((await runtime.snapshot()).name).toBe("Fix durable session resume");
			expect((await runtime.snapshot()).nameSource).toBe("generated");
			await runtime.run("explicit", {
				command: "session/name/set",
				sessionId: "naming-session",
				payload: { name: "Manual title" },
			});
			await runtime.run("ignored", { command: "session/name/generate", sessionId: "naming-session", payload: {} });
			expect((await runtime.snapshot()).name).toBe("Manual title");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("maps a durable harness to an accepted and executable turn runtime", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-faux",
			models: [{ id: "coding-agent-v2-model", reasoning: true, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("adapter response")]);
		const session = new Session(new InMemorySessionStorage({ id: "adapter-session", createdAt: 1 }));
		const goals = new GoalManager(session, () => 2);
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
			systemPrompt: "adapter",
		});
		try {
			const lifecycle: string[] = [];
			const extensionHost = new ServerRuntimeExtensionHost({
				resolveModel: () => ({ id: faux.getModel().id, provider: faux.getModel().provider }),
			});
			await extensionHost.register({
				id: "test-extension",
				onOperationAccepted: ({ operation }) => {
					lifecycle.push(`accepted:${operation.type}`);
				},
				onOperationTerminal: ({ operation, outcome }) => {
					lifecycle.push(`terminal:${operation.type}:${outcome}`);
				},
			});
			const service = createCodingAgentV2Service(models, [
				{
					metadata: { id: "adapter-session", createdAt: 1, updatedAt: 1 },
					harness: created.harness,
					goals,
					extensionHost,
				},
			]);
			const runtime = await service.openSession("adapter-session");
			const accepted = await runtime.accept("operation-1");
			await runtime.run("operation-1", {
				command: "turn/start",
				sessionId: "adapter-session",
				payload: { text: "hello" },
			});
			const turnSnapshot = await runtime.snapshot();
			const usageSnapshot = turnSnapshot.usage;
			expect(usageSnapshot.input).toBeGreaterThan(0);
			expect(usageSnapshot.output).toBeGreaterThan(0);
			expect(turnSnapshot.transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
			expect(lifecycle).toEqual(["accepted:turn/start", "terminal:turn/start:completed"]);
			await runtime.run("operation-2", {
				command: "goal/create",
				sessionId: "adapter-session",
				payload: { objective: "finish adapter" },
			});
			await runtime.accept("operation-3");
			await runtime.run("operation-3", {
				command: "session/thinking/set",
				sessionId: "adapter-session",
				payload: { level: "low" },
			});
			await runtime.accept("operation-4");
			await runtime.run("operation-4", {
				command: "session/name/generate",
				sessionId: "adapter-session",
				payload: { name: "Generated adapter" },
			});
			expect(accepted).toMatchObject({ operationId: "operation-1", sessionRevision: 1, eventSeq: 1 });
			expect((await runtime.snapshot()).model).toEqual({
				provider: "coding-agent-v2-faux",
				id: "coding-agent-v2-model",
			});
			expect((await runtime.snapshot()).goal).toMatchObject({ objective: "finish adapter", status: "active" });
			expect((await runtime.snapshot()).thinkingLevel).toBe("low");
			expect((await runtime.snapshot()).name).toBe("Generated adapter");
			expect((await runtime.snapshot()).nameSource).toBe("generated");
			await runtime.accept("operation-5");
			await runtime.run("operation-5", {
				command: "session/name/set",
				sessionId: "adapter-session",
				payload: { name: "Explicit adapter" },
			});
			await runtime.accept("operation-6");
			await runtime.run("operation-6", {
				command: "session/name/generate",
				sessionId: "adapter-session",
				payload: { name: "Ignored generated" },
			});
			expect((await runtime.snapshot()).name).toBe("Explicit adapter");
			expect((await runtime.snapshot()).nameSource).toBe("explicit");
			expect(await session.getName()).toBe("Explicit adapter");
			expect(
				(await session.findEntriesOnBranch({ order: "oldestFirst" })).filter((entry) => entry.type === "message"),
			).toHaveLength(2);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("projects durable transcript entries into the bounded v2 snapshot schema", async () => {
		const models = createModels();
		const faux = fauxProvider({ provider: "coding-agent-v2-schema", models: [{ id: "schema-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }] });
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "schema-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({ session, models, model: faux.getModel(), env, tools: [], activeToolNames: [], systemPrompt: "schema" });
		try {
			await session.appendMessage({ role: "user", content: "hello", timestamp: 2 });
			const runtime = await createCodingAgentV2Service(models, [{ metadata: { id: "schema-session", createdAt: 1, updatedAt: 2 }, harness: created.harness }]).then((service) => service.openSession("schema-session"));
			const snapshot = await runtime.snapshot();
			expect(Check(SessionSnapshotV2Schema, snapshot)).toBe(true);
			expect(snapshot.transcript[0]).toMatchObject({ id: expect.any(String), role: "user", timestamp: 2 });
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});
});
