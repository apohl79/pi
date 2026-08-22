import { createModels, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentHarness, HarnessClosed, type HarnessTool, type Resources } from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type LaneRecord,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";
import type { AgentMessage } from "../../src/types.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

class ThrowAfterOperationStartStorage extends InMemorySessionStorage {
	private injected = false;

	override async appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		const appended = await super.appendRecord(record);
		if (!this.injected && record.type === "operation_started") {
			this.injected = true;
			throw new Error("compaction admission response lost after commit");
		}
		return appended;
	}
}

class ThrowAfterOperationFinishedStorage extends InMemorySessionStorage {
	private injected = false;

	override async appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		const appended = await super.appendRecord(record);
		if (!this.injected && record.type === "operation_finished") {
			this.injected = true;
			throw new Error("terminal response lost after commit");
		}
		return appended;
	}
}

function createHarness(session = createSession()): Promise<AgentHarness> {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
	}).then(({ harness }) => harness);
}

function operationStarted(id: string): NewRecord<OperationStartedRecord> {
	return {
		type: "operation_started",
		id,
		lane: "main",
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

const userMessage: AgentMessage = {
	role: "user",
	content: [{ type: "text", text: "hello" }],
	timestamp: 1,
};

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentHarness v2 scaffold", () => {
	it("runs a deterministic prompt and persists its operation lifecycle", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-faux",
			models: [{ id: "harness-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hello from faux")]);
		const session = createSession("prompt");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });

		const result = await harness.prompt("hello");

		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		if (!result.ok || result.value.kind !== "completed") throw new Error("Expected completed prompt");
		expect(result.value.finalMessage.content).toEqual([{ type: "text", text: "hello from faux" }]);
		expect((await session.findRecords({ type: "operation_started" })).length).toBe(1);
		expect((await session.findRecords({ type: "operation_finished" })).map((record) => record.outcome)).toEqual([
			"completed",
		]);
		const messages = await session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(messages.filter((entry) => entry.type === "message").map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
		]);
		await harness.close();
	});

	it("runs idle callbacks after the durable lane is idle", async () => {
		const harness = await createHarness();
		let callbackCalled = false;
		await harness.waitForIdle();
		await harness.runWhenIdle(() => {
			callbackCalled = true;
		});
		expect(callbackCalled).toBe(true);
		await harness.close();
	});

	it("rolls back user turns while retaining historical entries", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-rollback-faux",
			models: [{ id: "harness-rollback-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = createSession("rollback");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });
		await harness.prompt("first");
		await harness.prompt("second");

		const result = await harness.rollback(1);

		expect(result).toMatchObject({ ok: true, value: { removedTurns: 1, targetId: expect.any(String) } });
		expect(
			(await session.findEntriesOnBranch({ order: "oldestFirst" })).some(
				(entry) => entry.type === "custom" && entry.customType === "conversation_rollback",
			),
		).toBe(true);
		expect(
			(await session.findEntries({ order: "oldestFirst" })).filter((entry) => entry.type === "message"),
		).toHaveLength(4);
		await harness.close();
	});

	it("compacts durable history and records the terminal operation", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-compaction-faux",
			models: [{ id: "harness-compaction-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		const session = createSession("compaction");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			compaction: {
				enabled: true,
				reserveTokens: 1,
				keepRecentTokens: 1,
				modelOverrides: { "harness-compaction-faux/harness-compaction-model": { reserveTokens: 7 } },
			},
		});
		expect(await harness.getCompactionSettings()).toMatchObject({
			enabled: true,
			reserveTokens: 7,
			keepRecentTokens: 1,
		});
		expect(await harness.getCompactionPolicySource()).toBe("mixed");
		await harness.prompt("first request with enough text to create history");
		await harness.prompt("second request with enough text to create history");
		faux.setResponses([fauxAssistantMessage("durable summary"), fauxAssistantMessage("durable turn prefix")]);

		const result = await harness.compact({ customInstructions: "focus on decisions" });

		expect(result).toMatchObject({ ok: true, value: { kind: "completed", entry: { type: "compaction" } } });
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.some((entry) => entry.type === "compaction" && entry.summary.includes("durable summary"))).toBe(
			true,
		);
		expect((await session.findRecords({ type: "operation_finished" })).at(-1)?.outcome).toBe("completed");
		await harness.close();
	});

	it("continues compaction when admission reports an error after commit", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-compaction-admission-faux",
			models: [{ id: "harness-compaction-admission-model", contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("first response")]);
		const session = new Session(new ThrowAfterOperationStartStorage({ id: "compaction-admission", createdAt: 1 }));
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		});
		expect(await harness.prompt("create durable history")).toMatchObject({ ok: true, value: { kind: "completed" } });
		faux.setResponses([fauxAssistantMessage("durable summary")]);

		const result = await harness.compact();

		expect(result).toMatchObject({ ok: true, value: { kind: "completed", entry: { type: "compaction" } } });
		expect((await session.findRecords({ type: "operation_finished" })).at(-1)?.outcome).toBe("completed");
		await harness.close();
	});

	it("recovers navigation admission when the start record was already committed", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-navigation-admission-faux",
			models: [{ id: "harness-navigation-admission-model", contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		const session = new Session(new ThrowAfterOperationStartStorage({ id: "navigation-admission", createdAt: 1 }));
		await session.appendMessage(userMessage);
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });

		const result = await harness.navigateTree(null);

		expect(result).toMatchObject({ ok: true, value: { kind: "completed", newLeafId: null } });
		await harness.close();
	});

	it("automatically compacts before a turn crosses the resolved threshold", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-auto-compaction-faux",
			models: [{ id: "harness-auto-compaction-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("first response")]);
		const session = createSession("auto-compaction");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			compaction: { enabled: true, reserveTokens: 31_999, keepRecentTokens: 1 },
		});
		await harness.prompt("first request");
		faux.setResponses([fauxAssistantMessage("durable summary"), fauxAssistantMessage("second response")]);
		const result = await harness.prompt("second request");
		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(
			(await session.findEntriesOnBranch({ order: "oldestFirst" })).some((entry) => entry.type === "compaction"),
		).toBe(true);
		await harness.close();
	});

	it("preflights compaction before switching to a smaller model", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-model-switch-faux",
			models: [
				{ id: "large-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "small-model", reasoning: false, contextWindow: 100, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			{
				...fauxAssistantMessage("large response"),
				usage: { ...usage, input: 100, totalTokens: 100 },
			},
		]);
		const session = createSession("model-switch-preflight");
		const largeModel = faux.getModel("large-model");
		const smallModel = faux.getModel("small-model");
		if (!largeModel || !smallModel) throw new Error("Expected faux model catalog entries");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: largeModel,
			compaction: { enabled: true, reserveTokens: 99, keepRecentTokens: 1 },
		});
		await harness.prompt("history that should exceed the smaller model threshold");
		faux.setResponses([fauxAssistantMessage("switch summary"), fauxAssistantMessage("small response")]);
		await harness.setModel(smallModel);
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.some((entry) => entry.type === "compaction" && entry.summary.includes("switch summary"))).toBe(
			true,
		);
		const result = await harness.prompt("continue on the small model");
		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		await harness.close();
	});

	it("includes system prompt and tool overhead in model-switch preflight", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-model-switch-overhead-faux",
			models: [
				{ id: "large-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "small-model", reasoning: false, contextWindow: 100, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("large response"), fauxAssistantMessage("switch summary")]);
		const session = createSession("model-switch-overhead");
		const largeModel = faux.getModel("large-model");
		const smallModel = faux.getModel("small-model");
		if (!largeModel || !smallModel) throw new Error("Expected faux model catalog entries");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: largeModel,
			compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 },
			systemPrompt: "x".repeat(1_000),
		});
		await harness.prompt("short history");
		await harness.setModel(smallModel);
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.some((entry) => entry.type === "compaction" && entry.summary.includes("switch summary"))).toBe(
			true,
		);
		await harness.close();
	});

	it("includes request-only sampling input in model-switch preflight", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-model-switch-sampling-faux",
			models: [
				{ id: "large-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 },
				{ id: "small-model", reasoning: false, contextWindow: 100, maxTokens: 1_000 },
			],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("large response"), fauxAssistantMessage("sampling summary")]);
		const session = createSession("model-switch-sampling");
		const largeModel = faux.getModel("large-model");
		const smallModel = faux.getModel("small-model");
		if (!largeModel || !smallModel) throw new Error("Expected faux model catalog entries");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: largeModel,
			compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 },
			samplingInput: () => [{ role: "user", content: "x".repeat(1_000), timestamp: 1 }],
		});
		await harness.prompt("short history");
		await harness.setModel(smallModel);
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(entries.some((entry) => entry.type === "compaction" && entry.summary.includes("sampling summary"))).toBe(
			true,
		);
		await harness.close();
	});

	it("discovers unfinished operations for crash recovery", async () => {
		const session = createSession();
		const { harness, suspended } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});

		expect(suspended).toEqual([]);
		expect(harness.name).toBe("main");
		expect(harness.session).toBe(session);
		expect(await harness.getLeafId()).toBeNull();
		expect(await harness.session.getLeafId()).toBeNull();

		await expect(harness.close()).resolves.toBeUndefined();

		const recorded = createSession("recorded");
		await recorded.appendRecord(operationStarted("run"));
		const restored = await AgentHarness.create({
			session: recorded,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});
		expect(restored.suspended).toMatchObject([
			{
				lane: "main",
				kind: "run",
				id: "run",
				startedAt: expect.any(Number),
				reason: "crash",
				missing: { tools: [], models: [] },
			},
		]);
		await restored.harness.close();
	});

	it("persists usage adjustments in the durable session ledger", async () => {
		const session = createSession("usage");
		const harness = await createHarness(session);
		const result = await harness.recordUsage(usage, { entryId: "assistant-1", details: { purpose: "agent" } });
		expect(result).toEqual({ ok: true, value: undefined });
		const records = await session.findRecords({ type: "usage", order: "oldestFirst" });
		expect(records).toMatchObject([
			{ type: "usage", cause: "adjustment", entryId: "assistant-1", details: { purpose: "agent" }, usage },
		]);
		await harness.close();
	});

	it("allows usage adjustments without an entry identity", async () => {
		const session = createSession("usage-without-entry");
		const harness = await createHarness(session);
		await harness.recordUsage(usage);
		expect(await session.findRecords({ type: "usage" })).toMatchObject([
			{ type: "usage", cause: "adjustment", usage },
		]);
		await harness.close();
	});

	it("persists model, thinking, and active-tool projection changes", async () => {
		const session = createSession("projection");
		const harness = await createHarness(session);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		await harness.setModel(model);
		await harness.setThinkingLevel("high");
		await harness.setActiveTools(["read", "bash"]);
		const entries = await session.findEntries({ order: "oldestFirst" });
		expect(entries).toMatchObject([
			{ type: "model_change", provider: model.provider, modelId: model.id },
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{ type: "active_tools_change", activeToolNames: ["read", "bash"] },
		]);
		await harness.close();
		const reopened = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});
		expect((await reopened.harness.getModel()).provider).toBe("google");
		expect((await reopened.harness.getModel()).id).toBe("gemini-2.5-flash");
		expect(await reopened.harness.getThinkingLevel()).toBe("high");
		expect(await reopened.harness.getActiveTools()).toEqual(["read", "bash"]);
		await reopened.harness.close();
	});

	it("persists retry policy changes across harness recreation", async () => {
		const session = createSession("retry-policy");
		const harness = await createHarness(session);
		await harness.setRetryPolicy({ enabled: true, maxRetries: 3, baseDelayMs: 17 });
		await harness.close();
		const reopened = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});
		expect(await reopened.harness.getRetryPolicy()).toEqual({
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 17,
		});
		await reopened.harness.close();
	});

	it("persists compaction settings across harness recreation", async () => {
		const session = createSession("compaction-settings");
		const harness = await createHarness(session);
		await harness.setCompactionSettings({ enabled: false, reserveTokens: 123, keepRecentTokens: 456 });
		await harness.close();
		const reopened = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});
		expect(await reopened.harness.getCompactionSettings()).toMatchObject({
			enabled: false,
			reserveTokens: 123,
			keepRecentTokens: 456,
		});
		await reopened.harness.close();
	});

	it("toggles the active model compaction override without losing policy fields", async () => {
		const session = createSession("compaction-override-toggle");
		const { harness } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			compaction: {
				enabled: true,
				reserveTokens: 123,
				keepRecentTokens: 456,
				modelOverrides: { "google/gemini-2.5-flash": { enabled: false, reserveTokens: 789 } },
			},
		});
		await harness.setCompactionEnabled(true);
		expect(await harness.getCompactionSettings()).toMatchObject({
			enabled: true,
			reserveTokens: 789,
			keepRecentTokens: 456,
		});
		await harness.close();
	});

	it("persists steering and follow-up queue modes across harness recreation", async () => {
		const session = createSession("queue-modes");
		const harness = await createHarness(session);
		await harness.setSteeringMode("all");
		await harness.setFollowUpMode("one-at-a-time");
		await harness.close();
		const reopened = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});
		expect(await reopened.harness.getSteeringMode()).toBe("all");
		expect(await reopened.harness.getFollowUpMode()).toBe("one-at-a-time");
		await reopened.harness.close();
	});

	it("runs registered lifecycle hooks and emits operation events", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-lifecycle-faux",
			models: [{ id: "harness-lifecycle-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("lifecycle response")]);
		const session = createSession("lifecycle");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });
		const hooks: string[] = [];
		const events: string[] = [];
		harness.hooks.on("before_run", () => hooks.push("before_run"));
		harness.hooks.on("after_response", () => hooks.push("after_response"));
		harness.events.on("operation_started", () => {
			events.push("started");
		});
		harness.events.on("operation_finished", () => {
			events.push("finished");
		});
		await harness.prompt("run lifecycle");
		expect(hooks).toEqual(["before_run", "after_response"]);
		expect(events).toEqual(["started", "finished"]);
		await harness.close();
	});

	it("invokes configured skills and prompt templates through durable prompts", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-resource-faux",
			models: [{ id: "harness-resource-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("skill response"), fauxAssistantMessage("template response")]);
		const session = createSession("resources");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			resources: {
				skills: [
					{ name: "review", description: "Review code", content: "Inspect carefully", filePath: "/tmp/SKILL.md" },
				],
				promptTemplates: [{ name: "greet", content: "Hello $1, inspect $ARGUMENTS" }],
			},
		});

		const skillResult = await harness.skill("review", "focus on tests");
		const templateResult = await harness.promptFromTemplate("greet", ["Ada", "the diff"]);

		expect(skillResult).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(templateResult).toMatchObject({ ok: true, value: { kind: "completed" } });
		const prompts = (await session.findEntriesOnBranch({ order: "oldestFirst" })).flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
		);
		expect(prompts[0]).toContainEqual({ type: "text", text: expect.stringContaining('<skill name="review"') });
		expect(prompts[0]).toContainEqual({ type: "text", text: expect.stringContaining("focus on tests") });
		expect(prompts[1]).toEqual([{ type: "text", text: "Hello Ada, inspect Ada the diff" }]);
		await harness.close();
	});

	it("navigates the durable tree and persists an optional branch summary", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-navigation-faux",
			models: [{ id: "harness-navigation-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage("second response"),
			fauxAssistantMessage("branch summary"),
		]);
		const session = createSession("navigation");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });
		await harness.prompt("first");
		const firstUser = (await session.findEntriesOnBranch({ order: "oldestFirst" })).find(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		if (!firstUser) throw new Error("Expected first user entry");
		await harness.prompt("second");

		const result = await harness.navigateTree(firstUser.id, { summarize: true, label: "first branch" });

		expect(result).toMatchObject({ ok: true, value: { kind: "completed", newLeafId: expect.any(String) } });
		expect(await session.getLeafId()).toBe((result as { ok: true; value: { newLeafId: string } }).value.newLeafId);
		expect(await session.getLabel(firstUser.id)).toBe("first branch");
		expect((await session.findEntriesOnBranch({ order: "oldestFirst" })).at(-1)).toMatchObject({
			type: "branch_summary",
			fromId: expect.any(String),
			summary: expect.stringContaining("branch summary"),
		});
		expect((await session.findRecords({ type: "operation_finished" })).at(-1)?.outcome).toBe("completed");
		await harness.close();
	});

	it("resumes a suspended run without leaving two open operations", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "harness-resume-faux",
			models: [{ id: "harness-resume-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("resumed response")]);
		const session = createSession("resume");
		await session.appendRecord({
			type: "operation_started",
			id: "crashed-run",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [userMessage], initialMessages: [] },
		});
		const { harness, suspended } = await AgentHarness.create({ session, models, model: faux.getModel() });
		expect(suspended).toMatchObject([{ id: "crashed-run", kind: "run", reason: "crash" }]);

		const result = await harness.resume();

		expect(result).toMatchObject({ ok: true, value: { operation: "run", kind: "completed" } });
		expect(await session.findOpenOperations("main")).toEqual([]);
		expect(
			(await session.findRecords({ type: "operation_finished", order: "oldestFirst" })).map(
				(record) => record.runId,
			),
		).toEqual(["crashed-run", expect.any(String)]);
		await harness.close();
	});

	it("persists queued steering, follow-up, next-run input, and cancellation", async () => {
		const session = createSession("queues");
		const harness = await createHarness(session);
		await expect(harness.steer(userMessage)).resolves.toMatchObject({ ok: false, error: { name: "NoActiveRun" } });
		await session.appendRecord(operationStarted("run"));
		const steer = await harness.steer("steer now");
		const followUp = await harness.followUp("follow up later");
		const nextRun = await harness.nextRun("next run");
		expect(steer).toMatchObject({ ok: true, value: { entryId: expect.any(String) } });
		expect(followUp).toMatchObject({ ok: true, value: { entryId: expect.any(String) } });
		expect(nextRun).toMatchObject({ ok: true, value: { entryId: expect.any(String) } });
		const queued = await session.findRecords({ type: "queue_enqueued", order: "oldestFirst" });
		expect(queued.map((record) => record.queue)).toEqual(["steer", "followUp", "nextRun"]);
		const entryId = nextRun.ok ? nextRun.value.entryId : "missing";
		expect(await harness.cancelQueued(entryId)).toEqual({ ok: true, value: { outcome: "cancelled" } });
		expect(await harness.cancelQueued(entryId)).toEqual({ ok: true, value: { outcome: "already_cleared" } });
		await harness.close();
	});

	it("durably aborts a run and recalls only steer/follow-up input", async () => {
		const session = createSession("abort");
		const harness = await createHarness(session);
		await session.appendRecord(operationStarted("run-1"));
		const steer = await harness.steer("steer");
		const followUp = await harness.followUp("follow");
		await harness.nextRun("next");
		const result = await harness.abort();
		expect(result).toMatchObject({
			ok: true,
			value: { runId: "run-1", steer: [{ role: "user" }], followUp: [{ role: "user" }] },
		});
		const records = await session.findRecords({ order: "oldestFirst" });
		expect(records.filter((record) => record.type === "abort_requested")).toHaveLength(1);
		expect(records.filter((record) => record.type === "operation_finished")).toMatchObject([{ outcome: "aborted" }]);
		expect(records.filter((record) => record.type === "queue_cancelled")).toHaveLength(2);
		expect(steer.ok && followUp.ok).toBe(true);
		await harness.close();
	});

	it("keeps scaffold-safe configuration as defensive copies", async () => {
		const harness = await createHarness();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		await harness.setModel(model);
		expect(await harness.getModel()).toBe(model);

		await harness.setThinkingLevel("high");
		expect(await harness.getThinkingLevel()).toBe("high");

		const activeTools = ["one"];
		await harness.setActiveTools(activeTools);
		activeTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);
		const readActiveTools = await harness.getActiveTools();
		readActiveTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);

		const tool = { name: "tool", label: "Tool" } as HarnessTool;
		const tools = [tool];
		await harness.setTools(tools);
		tools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);
		const readTools = await harness.getTools();
		readTools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);

		const resources: Resources = {
			skills: [{ name: "skill", description: "desc", content: "body", filePath: "/tmp/SKILL.md" }],
			promptTemplates: [{ name: "template", content: "body" }],
		};
		await harness.setResources(resources);
		resources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);
		const readResources = await harness.getResources();
		readResources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);

		const streamOptions = { maxTokens: 10 };
		await harness.setStreamOptions(streamOptions);
		streamOptions.maxTokens = 20;
		expect(await harness.getStreamOptions()).toEqual({ maxTokens: 10 });
		const readStreamOptions = await harness.getStreamOptions();
		readStreamOptions.maxTokens = 30;
		expect(await harness.getStreamOptions()).toEqual({ maxTokens: 10 });

		const retryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 10 };
		await harness.setRetryPolicy(retryPolicy);
		retryPolicy.maxRetries = 99;
		expect(await harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });

		const compactionSettings = { enabled: false, reserveTokens: 1, keepRecentTokens: 2 };
		await harness.setCompactionSettings(compactionSettings);
		compactionSettings.reserveTokens = 99;
		expect(await harness.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 1, keepRecentTokens: 2 });

		await harness.setSteeringMode("all");
		expect(await harness.getSteeringMode()).toBe("all");
		await harness.setFollowUpMode("all");
		expect(await harness.getFollowUpMode()).toBe("all");
	});

	it("provides durable lane and session watch snapshots with buffered run events", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "watch-faux",
			models: [{ id: "watch-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("watched")]);
		const { harness } = await AgentHarness.create({
			session: createSession("watch"),
			models,
			model: faux.getModel(),
		});
		const laneWatch = await harness.watch();
		const sessionWatch = await harness.watchSession();
		expect(laneWatch.snapshot).toMatchObject({ lane: "main", leafId: null, operation: null, faulted: false });
		expect(sessionWatch.snapshot).toMatchObject({ faulted: false, lanes: [{ name: "main", leafId: null }] });
		const events: string[] = [];
		laneWatch.start((event) => events.push(String((event as { type: string }).type)));
		sessionWatch.start((event) => events.push(`session:${String((event as { type: string }).type)}`));
		await harness.prompt("watch me");
		expect(events).toEqual(["run_start", "session:run_start", "run_end", "session:run_end"]);
		laneWatch.unsubscribe();
		sessionWatch.unsubscribe();
		await harness.close();
	});

	it("rejects duplicate lane creation explicitly", async () => {
		const harness = await createHarness();
		expect(await harness.createLane("main", null)).toMatchObject({
			ok: false,
			error: { name: "LaneExists", lane: "main" },
		});
		await harness.close();
	});

	it("parks one provider action for manual drive and releases it explicitly", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "manual-drive-faux",
			models: [{ id: "manual-drive-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("manual response")]);
		const { harness } = await AgentHarness.create({
			models,
			model: faux.getModel(),
			session: createSession("manual"),
			drive: "manual",
		});
		const run = harness.prompt("manual prompt");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(await harness.peekAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		expect(await harness.executeAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		expect(await run).toMatchObject({ ok: true, value: { kind: "completed" } });
		await harness.close();
	});

	it("exposes the durable main lane and lane inventory", async () => {
		const harness = await createHarness();
		expect(await harness.lane("main")).toBe(harness);
		expect(await harness.lane("missing")).toBeUndefined();
		expect(await harness.lanes()).toEqual([{ name: "main", leafId: null, operation: null }]);
		await harness.close();
	});

	it("reports HarnessClosed for unfinished operations after close", async () => {
		const harness = await createHarness();
		await harness.close();

		expect(await harness.prompt("hello")).toMatchObject({ ok: false, error: { name: "Closed" } });
		await expect(harness.waitForIdle()).rejects.toBeInstanceOf(HarnessClosed);
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessClosed);
		expect(() => harness.events.on("event", () => {})).toThrow(HarnessClosed);
	});

	it("redacts credentials from failed assistant messages before durable append", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "transcript-redaction",
			models: [{ id: "redaction-model", contextWindow: 4096, maxTokens: 256 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				'upstream failed: {"api_key":"secret-value"}; Authorization: Bearer bearer-secret; sk-short-secret',
				{
					stopReason: "error",
					errorMessage: 'request failed: {"api-key":"json-secret"} Bearer bearer-error sk-project-secret',
				},
			),
		]);
		const session = createSession("transcript-redaction");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });

		const result = await harness.prompt("hello");
		expect(result).toMatchObject({ ok: true, value: { kind: "failed" } });
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(assistant).toBeDefined();
		if (assistant?.type !== "message" || assistant.message.role !== "assistant") return;
		const text = assistant.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		expect(text).toContain("upstream failed");
		expect(text).not.toMatch(/secret-value|bearer-secret|short-secret/);
		expect(assistant.message.errorMessage).toContain("request failed");
		expect(assistant.message.errorMessage).not.toMatch(/json-secret|bearer-error|project-secret/);
		expect(assistant.message.errorMessage!.length).toBeLessThanOrEqual(512);
		await harness.close();
	});

	it("records provider error stops as failed operations", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "provider-error-terminal-faux",
			models: [{ id: "provider-error-terminal-model", contextWindow: 4096, maxTokens: 256 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
		const session = createSession("provider-error-terminal");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });

		const result = await harness.prompt("hello");

		expect(result).toMatchObject({ ok: true, value: { kind: "failed", error: { code: "run_error" } } });
		expect((await session.findRecords({ type: "operation_finished" })).at(-1)).toMatchObject({
			outcome: "failed",
			error: { code: "run_error", message: "provider failed" },
		});
		await harness.close();
	});

	it("does not duplicate a terminal record after its commit response is lost", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "terminal-commit-race-faux",
			models: [{ id: "terminal-commit-race-model", contextWindow: 4096, maxTokens: 256 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("done")]);
		const storage = new ThrowAfterOperationFinishedStorage({ id: "terminal-commit-race", createdAt: 1 });
		const session = new Session(storage);
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });

		await harness.prompt("hello");

		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(1);
		await harness.close();
	});

	it("redacts caught run failures before durable persistence", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "caught-run-error-faux",
			models: [{ id: "caught-run-error-model", contextWindow: 4096, maxTokens: 256 }],
		});
		models.setProvider(faux.provider);
		const session = createSession("caught-run-error");
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
		});
		harness.hooks.on("before_run", () => {
			throw new Error('request failed: {"api_key":"secret-value"} Bearer bearer-secret');
		});

		await harness.prompt("hello");

		expect((await session.findRecords({ type: "operation_finished" })).at(-1)).toMatchObject({
			outcome: "failed",
			error: { code: "run_failed", message: 'request failed: {"api_key"=[redacted]} Bearer [redacted]' },
		});
		await harness.close();
	});
});
