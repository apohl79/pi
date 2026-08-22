import { GoalContinuationScheduler, GoalManager, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	InMemoryForensicRecorder,
	InMemoryV2InputRegistry,
	InMemoryV2PlanRegistry,
	InMemoryV2UsageLedger,
} from "@earendil-works/pi-server";
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
		expect(normalizeGeneratedName("one word")).toBe("one word");
		expect(normalizeGeneratedName("answer.")).toBeUndefined();
		expect(normalizeGeneratedName("api_key=secret-value hidden title")).toBeUndefined();
		expect(normalizeGeneratedName("A very long session title that exceeds the display limit")).toBe(
			"A very long session title that",
		);
	});

	test("delivers durable child completions on the parent next turn", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-completion-queue-faux",
			models: [{ id: "completion-queue-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("parent response"), fauxAssistantMessage("second response")]);
		const session = new Session(new InMemorySessionStorage({ id: "completion-queue-session", createdAt: 1 }));
		const diagnostics = new InMemoryForensicRecorder();
		await session.appendCustomEntry("agent_completion", {
			version: 1,
			agentId: "child-1",
			path: "/root/worker",
			taskName: "worker",
			state: "complete",
			role: "reviewer",
			model: { provider: "child-provider", id: "child-model" },
		});
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: faux.getModel(),
			env,
			tools: [],
			activeToolNames: [],
			systemPrompt: "completion queue",
		});
		try {
			const service = createCodingAgentV2Service(models, [
				{
					metadata: { id: "completion-queue-session", createdAt: 1, updatedAt: 1 },
					harness: created.harness,
					forensicRecorder: diagnostics,
				},
			]);
			const runtime = await service.openSession("completion-queue-session");
			await runtime.run("disable-auto-name", {
				command: "session/name/auto/set",
				sessionId: "completion-queue-session",
				payload: { enabled: false },
			});
			await runtime.run("completion-turn-1", {
				command: "turn/start",
				sessionId: "completion-queue-session",
				payload: { text: "continue" },
			});
			const messages = (await session.findEntries({ order: "oldestFirst" })).filter(
				(entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message",
			);
			const firstUser = messages.find((entry) => entry.message.role === "user");
			expect(firstUser).toBeDefined();
			expect(JSON.stringify(firstUser?.message)).toContain("/root/worker (complete) role=reviewer");
			expect((await session.findEntries({ customType: "agent_completion_consumed" })).length).toBe(1);
			expect((await diagnostics.read()).map((event) => event.kind)).toEqual(["agent_completion_delivered"]);
			await runtime.run("completion-turn-2", {
				command: "turn/start",
				sessionId: "completion-queue-session",
				payload: { text: "continue again" },
			});
			const updatedMessages = (await session.findEntries({ order: "oldestFirst" })).filter(
				(entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message",
			);
			expect(JSON.stringify(updatedMessages.at(-2)?.message)).not.toContain("[child agent completions]");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("projects a pending structured input request as awaitingInput", async () => {
		const models = createModels();
		const session = new Session(new InMemorySessionStorage({ id: "awaiting-input-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: getModel("google", "gemini-2.5-flash"),
			env,
		});
		const inputs = new InMemoryV2InputRegistry();
		const plans = new InMemoryV2PlanRegistry();
		const diagnostics = new InMemoryForensicRecorder();
		await diagnostics.record({ kind: "turn_failed", sessionId: "awaiting-input-session", severity: "error" });
		await plans.update("awaiting-input-session", { items: [{ step: "Inspect queue", status: "in_progress" }] });
		const service = createCodingAgentV2Service(models, [
			{
				metadata: { id: "awaiting-input-session", createdAt: 1, updatedAt: 1 },
				harness: created.harness,
				inputs,
				plan: async () => plans.read("awaiting-input-session"),
				diagnostics: async () => {
					const events = await diagnostics.read();
					return {
						capture: "metadata",
						degraded: events.some((event) => event.severity === "error"),
						lastCriticalEventSeq: events.at(-1)?.seq ?? 0,
					};
				},
				queues: async () => ({
					steer: [
						{
							entryId: "queued-steer",
							message: { role: "user", content: [{ type: "text", text: "queued" }], timestamp: 7 },
						},
					],
					followUp: [],
				}),
			},
		]);
		const request = await inputs.create("awaiting-input-session", [{ id: "answer", prompt: "Answer?" }]);
		try {
			expect(await (await service.openSession("awaiting-input-session")).snapshot()).toMatchObject({
				phase: "awaitingInput",
				diagnostics: { capture: "metadata", degraded: true, lastCriticalEventSeq: 1 },
				plan: { version: 1, items: [{ step: "Inspect queue", status: "in_progress" }] },
				queues: { steer: [{ id: "queued-steer", content: [{ type: "text", text: "queued" }] }] },
			});
		} finally {
			await inputs.cancel(request.id);
			await created.harness.close();
			await env.cleanup();
		}
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
		await goals.create("Finish the task", 100_000);
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
			expect((await runtime.snapshot()).goal).toMatchObject({ status: "active" });
			expect((await runtime.snapshot()).goal?.tokensUsed).toBeGreaterThan(0);
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
			await expect(
				runtime.run("invalid-generated", {
					command: "session/name/generate",
					sessionId: "naming-session",
					payload: { name: "answer." },
				}),
			).rejects.toThrow("safe bounded name");
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

	test("falls back to the session model when no fast model is configured", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-naming-fallback-faux",
			models: [{ id: "session-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("turn response"), fauxAssistantMessage("Recover daemon state")]);
		const session = new Session(new InMemorySessionStorage({ id: "naming-fallback-session", createdAt: 1 }));
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
				{ metadata: { id: "naming-fallback-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]);
			const runtime = await service.openSession("naming-fallback-session");
			await runtime.run("fallback-name", {
				command: "turn/start",
				sessionId: "naming-fallback-session",
				payload: { text: "recover" },
			});
			expect((await runtime.snapshot()).name).toBe("Recover daemon state");
			expect((await runtime.snapshot()).nameSource).toBe("generated");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("does not fail a completed turn when side-band naming fails", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-naming-failure-faux",
			models: [{ id: "session-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("turn response")]);
		const session = new Session(new InMemorySessionStorage({ id: "naming-failure-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({ session, models, model: faux.getModel(), env, tools: [] });
		try {
			const runtime = await createCodingAgentV2Service(models, [
				{ metadata: { id: "naming-failure-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]).openSession("naming-failure-session");
			await expect(
				runtime.run("naming-failure", {
					command: "turn/start",
					sessionId: "naming-failure-session",
					payload: { text: "complete this turn" },
				}),
			).resolves.toBeUndefined();
			expect((await runtime.snapshot()).phase).toBe("idle");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("records compaction responses with compaction usage purpose", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-compaction-usage-faux",
			models: [{ id: "model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("turn response"), fauxAssistantMessage("compaction summary")]);
		const session = new Session(new InMemorySessionStorage({ id: "compaction-usage-session", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({ session, models, model: faux.getModel(), env, tools: [] });
		const usage = new InMemoryV2UsageLedger();
		try {
			const runtime = await createCodingAgentV2Service(models, [
				{
					metadata: { id: "compaction-usage-session", createdAt: 1, updatedAt: 1 },
					harness: created.harness,
					usage,
				},
			]).openSession("compaction-usage-session");
			await runtime.run("disable-auto-name", {
				command: "session/name/auto/set",
				sessionId: "compaction-usage-session",
				payload: { enabled: false },
			});
			await runtime.run("turn", {
				command: "turn/start",
				sessionId: "compaction-usage-session",
				payload: { text: "history" },
			});
			await runtime.run("compact", {
				command: "turn/compact",
				sessionId: "compaction-usage-session",
				payload: {},
			});
			expect(await usage.read({ purpose: "compaction" })).toHaveLength(1);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("persists the automatic naming setting across runtime recreation", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-auto-name-faux",
			models: [{ id: "coding-agent-v2-auto-name-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("turn response"), fauxAssistantMessage("should not be sampled")]);
		const session = new Session(new InMemorySessionStorage({ id: "auto-name-setting-session", createdAt: 1 }));
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
			const definition = {
				metadata: { id: "auto-name-setting-session", createdAt: 1, updatedAt: 1 },
				harness: created.harness,
			};
			const first = await createCodingAgentV2Service(models, [definition]).openSession("auto-name-setting-session");
			await first.run("disable-auto-name", {
				command: "session/name/auto/set",
				sessionId: "auto-name-setting-session",
				payload: { enabled: false },
			});
			await first.run("explicit-name", {
				command: "session/name/set",
				sessionId: "auto-name-setting-session",
				payload: { name: "Persisted manual title" },
			});
			const recreated = await createCodingAgentV2Service(models, [definition], { fastModel: faux.getModel() });
			const second = await recreated.openSession("auto-name-setting-session");
			await second.run("turn", {
				command: "turn/start",
				sessionId: "auto-name-setting-session",
				payload: { text: "work" },
			});
			expect((await second.snapshot()).name).toBe("Persisted manual title");
			expect((await second.snapshot()).nameSource).toBe("explicit");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("toggles the active model compaction override through the v2 command", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-compaction-faux",
			models: [
				{ id: "coding-agent-v2-compaction-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "compaction-toggle-session", createdAt: 1 }));
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
			const activeModel = await created.harness.getModel();
			await created.harness.setCompactionSettings({
				enabled: true,
				reserveTokens: 123,
				keepRecentTokens: 456,
				modelOverrides: { [`${activeModel.provider}/${activeModel.id}`]: { enabled: false, reserveTokens: 789 } },
			});
			expect(await created.harness.getCompactionSettings()).toMatchObject({ enabled: false, reserveTokens: 789 });
			const runtime = createCodingAgentV2Service(models, [
				{ metadata: { id: "compaction-toggle-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]).openSession("compaction-toggle-session");
			const opened = await runtime;
			expect((await opened.snapshot()).compactionPolicy.enabled).toBe(false);
			await opened.run("enable-compaction", {
				command: "session/compaction/set",
				sessionId: "compaction-toggle-session",
				payload: { enabled: true },
			});
			expect((await opened.snapshot()).compactionPolicy).toMatchObject({
				enabled: true,
				reserveTokens: 789,
				keepRecentTokens: 456,
			});
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("freezes compaction policy on operation acceptance", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "coding-agent-v2-frozen-policy-faux",
			models: [
				{ id: "coding-agent-v2-frozen-policy-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		const session = new Session(new InMemorySessionStorage({ id: "frozen-policy-session", createdAt: 1 }));
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
			await created.harness.setCompactionSettings({ enabled: false, reserveTokens: 123, keepRecentTokens: 456 });
			const opened = await createCodingAgentV2Service(models, [
				{ metadata: { id: "frozen-policy-session", createdAt: 1, updatedAt: 1 }, harness: created.harness },
			]).openSession("frozen-policy-session");
			const accepted = await opened.accept("frozen-operation");
			expect(accepted.compactionPolicy).toMatchObject({ enabled: false, reserveTokens: 123, keepRecentTokens: 456 });
			await created.harness.setCompactionSettings({ enabled: true, reserveTokens: 999, keepRecentTokens: 888 });
			expect((await opened.snapshot()).activeOperation?.compactionPolicy).toMatchObject({
				enabled: false,
				reserveTokens: 123,
				keepRecentTokens: 456,
			});
			expect((await opened.snapshot()).compactionPolicy).toMatchObject({ enabled: true, reserveTokens: 999 });
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
});
