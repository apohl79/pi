import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AgentHarness, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function createSession(id: string): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

describe("AgentHarness manual tool drive", () => {
	it("parks a tool action before executing the tool", async () => {
		const models = createModels();
		const faux = fauxProvider({
			provider: "manual-tool-faux",
			models: [{ id: "manual-tool-model", reasoning: false, contextWindow: 32_000, maxTokens: 1_000 }],
		});
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } },
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("tool complete"),
		]);
		const executed: string[] = [];
		const parameters = Type.Object({ value: Type.String() });
		const tool: HarnessTool = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters,
			async execute(_toolCallId, params) {
				const value =
					typeof params === "object" && params !== null && "value" in params && typeof params.value === "string"
						? params.value
						: "";
				executed.push(value);
				return { content: [{ type: "text", text: value }], details: { value } };
			},
		};
		const { harness } = await AgentHarness.create({
			models,
			model: faux.getModel(),
			session: createSession("manual-tool"),
			drive: "manual",
			tools: [tool],
		});

		const run = harness.prompt("use the tool");
		await vi.waitFor(async () => {
			expect(await harness.peekAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		});
		expect(await harness.executeAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		await vi.waitFor(async () => {
			expect(await harness.peekAction()).toEqual({ kind: "execute_tool", toolCallId: "tool-1", toolName: "echo" });
		});
		expect(executed).toEqual([]);
		expect(await harness.executeAction()).toEqual({ kind: "execute_tool", toolCallId: "tool-1", toolName: "echo" });
		await vi.waitFor(async () => {
			expect(await harness.peekAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 2 });
		});
		expect(await harness.executeAction()).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 2 });
		expect(await run).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(executed).toEqual(["hello"]);
		await harness.close();
	});
});
