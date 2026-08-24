import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function createSession(id: string): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

describe("AgentHarness child lanes", () => {
	it("creates an executable child lane with an independent branch leaf", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "child-lane-faux",
			models: [{ id: "child-lane-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("parent response"), fauxAssistantMessage("child response")]);
		const session = createSession("child-lane");
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });

		const parentResult = await harness.prompt("parent prompt");
		expect(parentResult).toMatchObject({ ok: true, value: { kind: "completed" } });
		const parentLeaf = await harness.getLeafId();
		const childResult = await harness.createLane("child", parentLeaf);
		expect(childResult).toMatchObject({ ok: true, value: { name: "child" } });
		const child = (childResult as Extract<typeof childResult, { ok: true }>).value;
		const childRun = await child.prompt("child prompt");
		expect(childRun).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(await child.getLeafId()).not.toBe(parentLeaf);
		expect(
			(await session.view("child").findEntriesOnBranch({ order: "oldestFirst" })).map((entry) => entry.type),
		).toEqual(["message", "message", "message", "message"]);
		const childWatch = await child.watch();
		expect(childWatch.snapshot).toMatchObject({ lane: "child", leafId: await child.getLeafId() });
		childWatch.unsubscribe();
		expect((await harness.lanes()).map((lane) => lane.name)).toEqual(["main", "child"]);

		await harness.close();
	});
});
