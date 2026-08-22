import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createPluginSamplingInput } from "../../src/server/plugin-sampling.ts";

describe("plugin sampling adapter", () => {
	test("evaluates conditions in activation order and omits failed entries", async () => {
		const env = new NodeExecutionEnv({ cwd: process.cwd(), shellEnv: { PROJECT_CONTEXT_ENABLED: "1" } });
		const faux = fauxProvider({
			provider: "plugin-sampling-faux",
			models: [{ id: "plugin-sampling-model", reasoning: false, contextWindow: 8_192, maxTokens: 1_024 }],
		});
		const diagnostics: Array<{ pluginId: string; entryId: string; reason: string; durationMs?: number }> = [];
		const samplingInput = createPluginSamplingInput(
			env,
			[
				{
					pluginId: "second",
					activationOrder: 2,
					entries: [
						{
							id: "enabled",
							slot: "contextual_user",
							position: "supplement",
							text: "second",
						},
					],
				},
				{
					pluginId: "first",
					activationOrder: 1,
					entries: [
						{
							id: "disabled",
							slot: "contextual_user",
							position: "supplement",
							text: "disabled",
							conditionShell: 'test "$' + '{PROJECT_CONTEXT_ENABLED}" = 0',
						},
						{
							id: "enabled",
							slot: "contextual_user",
							position: "supplement",
							text: "first",
						},
					],
				},
			],
			(diagnostic) => diagnostics.push(diagnostic),
		);

		try {
			const messages = await samplingInput({ model: faux.getModel(), systemPrompt: "", messages: [], tools: [] });
			expect(
				messages.map((message) =>
					message.role === "user" && typeof message.content === "string" ? message.content : "",
				),
			).toEqual(["first", "second"]);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({ pluginId: "first", entryId: "disabled", reason: "condition_failed" });
			expect(diagnostics[0]?.durationMs).toEqual(expect.any(Number));
		} finally {
			await env.cleanup();
		}
	});
});
