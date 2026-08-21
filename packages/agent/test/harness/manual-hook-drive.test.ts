import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function createSession(id: string): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

describe("AgentHarness manual hook drive", () => {
	it("parks a registered lifecycle hook before invoking it", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "manual-hook-faux",
			models: [{ id: "manual-hook-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hook complete")]);
		const observed: unknown[] = [];
		const { harness } = await AgentHarness.create({
			models,
			model: faux.getModel(),
			session: createSession("manual-hook"),
			drive: "manual",
		});
		harness.hooks.on("before_run", (event) => {
			observed.push(event);
		});

		const run = harness.prompt("run with hook");
		await vi.waitFor(async () => {
			expect(await harness.peekAction()).toEqual({ kind: "hook", name: "before_run" });
		});
		expect(observed).toEqual([]);
		expect(await harness.executeAction()).toEqual({ kind: "hook", name: "before_run" });
		await vi.waitFor(async () => {
			expect(await harness.peekAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		});
		expect(observed).toHaveLength(1);
		expect(await harness.executeAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		expect(await run).toMatchObject({ ok: true, value: { kind: "completed" } });
		await harness.close();
	});
});
