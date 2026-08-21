import { GoalManager, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createCodingAgentHarness } from "../../src/server/create-harness.ts";
import { createCodingAgentV2Service } from "../../src/server/v2-service.ts";

describe("coding-agent v2 service adapter", () => {
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
			const service = createCodingAgentV2Service(models, [
				{ metadata: { id: "adapter-session", createdAt: 1, updatedAt: 1 }, harness: created.harness, goals },
			]);
			const runtime = await service.openSession("adapter-session");
			const accepted = await runtime.accept("operation-1");
			await runtime.run("operation-1", {
				command: "turn/start",
				sessionId: "adapter-session",
				payload: { text: "hello" },
			});
			const usageSnapshot = (await runtime.snapshot()).usage;
			expect(usageSnapshot.input).toBeGreaterThan(0);
			expect(usageSnapshot.output).toBeGreaterThan(0);
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
});
