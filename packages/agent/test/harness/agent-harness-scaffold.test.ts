import { createModels, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	HarnessClosed,
	HarnessNotImplemented,
	type HarnessTool,
	type Resources,
} from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";
import type { AgentMessage } from "../../src/types.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
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
			compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		});
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
		expect(restored.suspended).toHaveLength(1);
		expect(restored.suspended[0]).toMatchObject({ kind: "run", id: "run", reason: "crash" });
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

	it("rejects non-finite and unreasonably large compaction settings", async () => {
		const harness = await createHarness(createSession("compaction-settings-bounds"));
		await expect(
			harness.setCompactionSettings({ enabled: true, reserveTokens: Number.POSITIVE_INFINITY, keepRecentTokens: 1 }),
		).rejects.toThrow();
		await expect(
			harness.setCompactionSettings({ enabled: true, reserveTokens: 10_000_000, keepRecentTokens: 1 }),
		).rejects.toThrow();
		await expect(
			harness.setCompactionSettings({ enabled: true, reserveTokens: 9_000_000, keepRecentTokens: 2_000_001 }),
		).rejects.toThrow();
	});

	it("reconciles configuration when a durable append reports failure after commit", async () => {
		const session = createSession("append-then-throws");
		const harness = await createHarness(session);
		const appendEntry = session.appendEntry.bind(session);
		vi.spyOn(session, "appendEntry").mockImplementation(async (entry, lane) => {
			await appendEntry(entry, lane);
			throw new Error("reported after commit");
		});

		const model = getModel("anthropic", "claude-sonnet-4-5");
		await expect(harness.setModel(model)).rejects.toThrow("reported after commit");
		expect(await harness.getModel()).toBe(model);

		await expect(harness.setThinkingLevel("high")).rejects.toThrow("reported after commit");
		expect(await harness.getThinkingLevel()).toBe("high");

		await expect(harness.setActiveTools(["durable-tool"])).rejects.toThrow("reported after commit");
		expect(await harness.getActiveTools()).toEqual(["durable-tool"]);

		const tool = { name: "durable-tool", label: "Durable tool" } as HarnessTool;
		await expect(harness.setTools([tool])).rejects.toThrow("reported after commit");
		expect(await harness.getTools()).toEqual([tool]);
		expect(await harness.getActiveTools()).toEqual(["durable-tool"]);
	});

	it("rejects every unfinished public operation explicitly", async () => {
		const harness = await createHarness();
		const unfinished: [string, () => unknown | Promise<unknown>][] = [
			["resume", () => harness.resume()],
			["peekAction", () => harness.peekAction()],
			["executeAction", () => harness.executeAction()],
			["runToCompletion", () => harness.runToCompletion()],
			["watch", () => harness.watch()],
			["lane", () => harness.lane("main")],
			["createLane", () => harness.createLane("thread", null)],
			["lanes", () => harness.lanes()],
			["watchSession", () => harness.watchSession()],
		];

		for (const [operation, invoke] of unfinished) {
			await expect(Promise.resolve().then(invoke), operation).rejects.toMatchObject({
				name: "HarnessNotImplemented",
				operation,
			});
		}
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessNotImplemented);
		expect(() => harness.events.on("event", () => {})).toThrow(HarnessNotImplemented);
	});

	it("supports prompt lifecycle, queues, usage recording, and idle waiting", async () => {
		const session = createSession("implemented-operations");
		const harness = await createHarness(session);

		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		let callbackCalled = false;
		await harness.runWhenIdle(() => {
			callbackCalled = true;
		});
		expect(callbackCalled).toBe(true);

		await expect(harness.steer(userMessage)).resolves.toMatchObject({
			ok: false,
			error: { name: "NoActiveRun" },
		});
		await expect(harness.followUp(userMessage)).resolves.toMatchObject({
			ok: false,
			error: { name: "NoActiveRun" },
		});

		const nextRun = await harness.nextRun(userMessage);
		expect(nextRun.ok).toBe(true);
		if (!nextRun.ok) return;
		await expect(harness.cancelQueued(nextRun.value.entryId)).resolves.toEqual({
			ok: true,
			value: { outcome: "cancelled" },
		});
		await expect(harness.cancelQueued(nextRun.value.entryId)).resolves.toEqual({
			ok: true,
			value: { outcome: "already_cleared" },
		});

		await expect(harness.recordUsage(usage)).resolves.toEqual({ ok: true, value: undefined });
		expect(await session.findRecords({ type: "usage", lane: "main" })).toHaveLength(1);

		await session.appendRecord(operationStarted("run"));
		const steer = await harness.steer(userMessage);
		const followUp = await harness.followUp(userMessage);
		expect(steer.ok).toBe(true);
		expect(followUp.ok).toBe(true);
		await expect(harness.abort()).resolves.toMatchObject({ ok: true, value: { runId: "run" } });
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		expect(await session.findRecords({ type: "operation_finished", lane: "main" })).toHaveLength(1);
	});

	it("reports the closed state for operations after close", async () => {
		const harness = await createHarness();
		await harness.close();

		await expect(harness.prompt("hello")).resolves.toMatchObject({ ok: false, error: { name: "Closed" } });
		await expect(harness.compact()).resolves.toMatchObject({ ok: false, error: { name: "Closed" } });
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
				[
					{
						type: "text",
						text: 'upstream failed: {"api_key":"secret-value"}; Authorization: Bearer bearer-secret; sk-short-secret',
					},
					{
						type: "toolCall",
						id: "failed-tool-call",
						name: "request",
						arguments: { api_key: "tool-secret", nested: { authorization: "Bearer tool-bearer" } },
					},
				],
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
		const toolCall = assistant.message.content.find((part) => part.type === "toolCall");
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") return;
		expect(JSON.stringify(toolCall.arguments)).not.toMatch(/tool-secret|tool-bearer/);
		expect(assistant.message.errorMessage).toContain("request failed");
		expect(assistant.message.errorMessage).not.toMatch(/json-secret|bearer-error|project-secret/);
		expect(assistant.message.errorMessage!.length).toBeLessThanOrEqual(512);
		await harness.close();
	});

	it("redacts credentials from durable compaction output", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "compaction-redaction",
			models: [{ id: "compaction-model", contextWindow: 4096, maxTokens: 256 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("Summary: api_key=summary-secret\nBearer summary-bearer")]);
		const session = createSession("compaction-redaction");
		await session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old context" }],
			timestamp: 1,
		});
		await session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "read-secret", name: "read", arguments: { path: "/tmp/sk-project-secret-file" } }],
			api: "anthropic-messages",
			provider: faux.provider,
			model: faux.getModel().id,
			usage,
			stopReason: "stop",
			timestamp: 2,
		});
		await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "retained api_key=tail-secret Bearer tail-bearer" }],
			api: "anthropic-messages",
			provider: faux.provider,
			model: faux.getModel().id,
			usage,
			stopReason: "stop",
			timestamp: 3,
		});
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
		});

		const result = await harness.compact();
		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
		const entry = entries.find((candidate) => candidate.type === "compaction");
		expect(entry?.type).toBe("compaction");
		if (entry?.type !== "compaction") return;
		expect(entry.summary).toContain("Summary:");
		expect(entry.summary).not.toMatch(/summary-secret|summary-bearer/);
		const tailText = JSON.stringify(entry.retainedTail);
		expect(tailText).not.toMatch(/tail-secret|tail-bearer|sk-project-secret/);
		const detailsText = JSON.stringify(entry.details);
		expect(detailsText).not.toMatch(/sk-project-secret/);
		await harness.close();
	});
});
