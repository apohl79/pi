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
	it("opens only record-free sessions before restore is implemented", async () => {
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
		let callbackCalled = false;
		const unfinished: [string, () => unknown | Promise<unknown>][] = [
			["skill", () => harness.skill("skill")],
			["promptFromTemplate", () => harness.promptFromTemplate("template")],
			["navigateTree", () => harness.navigateTree(null)],
			["resume", () => harness.resume()],
			["abort", () => harness.abort()],
			["steer", () => harness.steer(userMessage)],
			["followUp", () => harness.followUp(userMessage)],
			["nextRun", () => harness.nextRun(userMessage)],
			["cancelQueued", () => harness.cancelQueued("queued")],
			["recordUsage", () => harness.recordUsage(usage)],
			["waitForIdle", () => harness.waitForIdle()],
			[
				"runWhenIdle",
				() =>
					harness.runWhenIdle(() => {
						callbackCalled = true;
					}),
			],
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
		expect(callbackCalled).toBe(false);
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessNotImplemented);
		expect(() => harness.events.on("event", () => {})).toThrow(HarnessNotImplemented);
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
