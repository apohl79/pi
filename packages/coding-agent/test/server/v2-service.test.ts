import { GoalContinuationScheduler, GoalManager, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createCodingAgentHarness } from "../../src/server/create-harness.ts";
import { ServerRuntimeExtensionHost } from "../../src/server/extension-host.ts";
import {
	createCodingAgentV2Service,
	createCodingAgentV2ServiceFromStore,
	normalizeGeneratedName,
} from "../../src/server/v2-service.ts";

describe("coding-agent v2 service adapter", () => {
	test("normalizes generated names to safe bounded titles", () => {
		expect(normalizeGeneratedName("Title: Fix durable session resume now")).toBe("Fix durable session resume now");
		expect(normalizeGeneratedName("Fix durable\u0085 session resume now")).toBe("Fix durable session resume now");
		expect(normalizeGeneratedName("one word")).toBe("one word");
		expect(normalizeGeneratedName("answer.")).toBeUndefined();
		expect(normalizeGeneratedName("api_key=secret-value hidden title")).toBeUndefined();
		expect(normalizeGeneratedName("token=secret-value hidden title")).toBeUndefined();
		expect(normalizeGeneratedName("password: secret-value hidden title")).toBeUndefined();
		expect(normalizeGeneratedName("secret=secret-value hidden title")).toBeUndefined();
		expect(normalizeGeneratedName("authorization: Bearer secret-value hidden title")).toBeUndefined();
		expect(normalizeGeneratedName("A very long session title that exceeds the display limit")).toBe(
			"A very long session title that",
		);
	});

	test("schedules an active goal continuation after a completed turn", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-goal-continuation-faux",
			models: [{ id: "goal-continuation-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("turn response")]);
		const session = new Session(new InMemorySessionStorage({ id: "goal-continuation-session", createdAt: 1 }));
		const goals = new GoalManager(session);
		await goals.create("Finish the task");
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
			systemPrompt: "continuation",
		});
		const continuations: string[] = [];
		const scheduler = new GoalContinuationScheduler({
			goals,
			waitForIdle: async (callback) => callback(),
			continueGoal: async (goal) => {
				continuations.push(goal.objective);
			},
			maxContinuations: 1,
		});
		try {
			const service = createCodingAgentV2Service(models, [
				{
					metadata: { id: "goal-continuation-session", createdAt: 1, updatedAt: 1 },
					harness: created.harness,
					goals,
					goalContinuation: scheduler,
				},
			]);
			const runtime = await service.openSession("goal-continuation-session");
			await runtime.run("goal-turn", {
				command: "turn/start",
				sessionId: "goal-continuation-session",
				payload: { text: "work" },
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(continuations).toEqual(["Finish the task"]);
		} finally {
			scheduler.close();
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("backs v2 session lifecycle with injected durable factories", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-session-faux",
			models: [{ id: "coding-agent-v2-session-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "factory-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
		});
		let deleted = false;
		try {
			const service = createCodingAgentV2Service(models, [], {
				createSession: async (payload) => ({
					metadata: { id: String(payload.id), createdAt: 1, updatedAt: 1 },
					harness: created.harness,
				}),
				deleteSession: async (sessionId) => {
					deleted = sessionId === "factory-session";
				},
			});
			const createdSession = await service.createSession!({ id: "factory-session" });
			expect(createdSession.sessionId).toBe("factory-session");
			expect((await service.listSessions()).map((item) => item.id)).toEqual(["factory-session"]);
			await service.deleteSession!("factory-session");
			expect(deleted).toBe(true);
			expect(await service.listSessions()).toEqual([]);
		} finally {
			if (!deleted) await created.harness.close();
			await env.cleanup();
		}
	});

	test("opens catalogued sessions lazily through a durable store", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-store-faux",
			models: [{ id: "coding-agent-v2-store-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "stored-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
		});
		let opened = 0;
		let deleted = false;
		const definition = { metadata: { id: "stored-session", createdAt: 1, updatedAt: 1 }, harness: created.harness };
		const store = {
			list: async () => [definition.metadata],
			open: async () => {
				opened += 1;
				return definition;
			},
			create: async () => definition,
			delete: async () => {
				deleted = true;
			},
		};
		try {
			const service = await createCodingAgentV2ServiceFromStore(models, store);
			expect(await service.listSessions()).toMatchObject([{ id: "stored-session" }]);
			expect(opened).toBe(0);
			await service.openSession("stored-session");
			expect(opened).toBe(1);
			await service.deleteSession!("stored-session");
			expect(deleted).toBe(true);
		} finally {
			if (!deleted) await created.harness.close();
			await env.cleanup();
		}
	});

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
			models: [{ id: "coding-agent-v2-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
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
			expect((await runtime.snapshot()).activeOperation).toMatchObject({
				operationId: "operation-1",
				kind: "pending",
				state: "accepted",
				acceptedSeq: 2,
			});
			await runtime.run("operation-1", {
				command: "turn/start",
				sessionId: "adapter-session",
				payload: { text: "hello" },
			});
			const turnSnapshot = await runtime.snapshot();
			const usageSnapshot = turnSnapshot.usage;
			expect(turnSnapshot).toMatchObject({
				phase: "idle",
				activeOperation: { operationId: "operation-1", kind: "turn/start", state: "complete", terminalSeq: 3 },
			});
			expect(usageSnapshot.input).toBeGreaterThan(0);
			expect(usageSnapshot.output).toBeGreaterThan(0);
			expect(turnSnapshot.transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
			expect(lifecycle).toEqual(["accepted:turn/start", "terminal:turn/start:completed"]);
			await expect(
				runtime.run("bad-operation", {
					command: "session/thinking/set",
					sessionId: "adapter-session",
					payload: {},
				}),
			).rejects.toThrow("requires level");
			expect(lifecycle.at(-1)).toBe("terminal:session/thinking/set:failed");
			expect((await runtime.snapshot()).activeOperation).toMatchObject({
				operationId: "bad-operation",
				kind: "session/thinking/set",
				state: "failed",
				terminalSeq: 4,
			});
			await runtime.run("operation-2", {
				command: "goal/create",
				sessionId: "adapter-session",
				payload: { objective: "finish adapter" },
			});
			await runtime.run("operation-3", {
				command: "session/thinking/set",
				sessionId: "adapter-session",
				payload: { level: "low" },
			});
			await runtime.run("operation-4", {
				command: "session/name/generate",
				sessionId: "adapter-session",
				payload: { name: "Generated adapter" },
			});
			expect(accepted).toMatchObject({ operationId: "operation-1", sessionRevision: 2, eventSeq: 2 });
			expect((await runtime.snapshot()).model).toEqual({
				provider: "coding-agent-v2-faux",
				id: "coding-agent-v2-model",
			});
			expect((await runtime.snapshot()).goal).toMatchObject({ objective: "finish adapter", status: "active" });
			expect((await runtime.snapshot()).thinkingLevel).toBe("low");
			expect((await runtime.snapshot()).name).toBe("Generated adapter");
			expect((await runtime.snapshot()).nameSource).toBe("generated");
			await runtime.run("operation-5", {
				command: "session/name/set",
				sessionId: "adapter-session",
				payload: { name: "Explicit adapter" },
			});
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

	test("preserves ordered text and image content in a remote turn", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-content-faux",
			models: [{ id: "coding-agent-v2-content-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("content response")]);
		const session = new Session(new InMemorySessionStorage({ id: "content-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
		});
		try {
			const service = createCodingAgentV2Service(models, [
				{ metadata: { id: "content-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]);
			const runtime = await service.openSession("content-session");
			await runtime.run("content-operation", {
				command: "turn/start",
				sessionId: "content-session",
				payload: {
					content: [
						{ type: "text", text: "inspect this" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
				},
			});
			const user = (await session.findEntriesOnBranch({ order: "oldestFirst" })).find(
				(entry) => entry.type === "message" && entry.message.role === "user",
			);
			expect(user).toMatchObject({
				message: {
					content: [
						{ type: "text", text: "inspect this" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
				},
			});
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("redacts credentials and bounds transcript content", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-transcript-faux",
			models: [{ id: "coding-agent-v2-transcript-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "transcript-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({ session, models, model: faux.getModel(), env, tools: [], activeToolNames: [] });
		try {
			await session.appendMessage({ role: "user", content: [{ type: "text", text: "Bearer secret-token\u0085" }], timestamp: 1 });
			await session.appendMessage(
				fauxAssistantMessage([fauxToolCall("run", { token: "tool-secret" }), { type: "text", text: "password=super-secret" }], {
					stopReason: "error",
					errorMessage: "authorization: Bearer error-secret\u009f",
					timestamp: 2,
				}),
			);
			const service = createCodingAgentV2Service(models, [
				{ metadata: { id: "transcript-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]);
			const transcript = (await (await service.openSession("transcript-session")).snapshot()).transcript;
			expect(transcript).toHaveLength(2);
			expect(JSON.stringify(transcript)).not.toContain("secret-token");
			expect(JSON.stringify(transcript)).not.toContain("super-secret");
			expect(JSON.stringify(transcript)).not.toContain("tool-secret");
			expect(JSON.stringify(transcript)).not.toContain("error-secret");
			expect(JSON.stringify(transcript)).not.toContain("\u0085");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("rejects non-object turn payloads", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-command-faux",
			models: [{ id: "coding-agent-v2-command-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "command-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({ session, models, model: faux.getModel(), env, tools: [], activeToolNames: [] });
		try {
			const service = createCodingAgentV2Service(models, [
				{ metadata: { id: "command-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]);
			const runtime = await service.openSession("command-session");
			await expect(
				runtime.run("invalid-command", { command: "turn/start", sessionId: "command-session", payload: undefined }),
			).rejects.toThrow("requires an object payload");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});
});
