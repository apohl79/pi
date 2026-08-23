import { describe, expect, test } from "vitest";
import type { Extension } from "../../src/core/extensions/types.ts";
import { type ServerRuntimeExtension, ServerRuntimeExtensionHost } from "../../src/server/extension-host.ts";
import {
	adaptPiExtensionSampling,
	inspectPiExtensionServerCompatibility,
} from "../../src/server/pi-extension-adapter.ts";

describe("adaptPiExtensionSampling", () => {
	test("bridges request-only sampling registrations and excludes extensions without them", async () => {
		const extension = {
			path: "/project/extensions/context.ts",
			samplingInputs: new Map([
				[
					"first",
					{
						id: "first",
						contribute: () => ({ role: "user", content: [{ type: "text", text: "one" }] }),
					},
				],
				[
					"second",
					{
						id: "second",
						contribute: async () => [
							{ role: "user", content: [{ type: "text", text: "two" }] },
							{ role: "user", content: [{ type: "text", text: "three" }] },
						],
					},
				],
			]),
		} as unknown as Extension;

		const adapted = adaptPiExtensionSampling(extension);
		expect(adapted).toHaveLength(2);
		expect(adapted.map((item) => item.id)).toEqual([
			"pi:/project/extensions/context.ts:sampling:first",
			"pi:/project/extensions/context.ts:sampling:second",
		]);
		expect(adapted).toEqual(
			expect.arrayContaining([expect.objectContaining({ scope: "server", capabilities: ["sampling-input"] })]),
		);
		const context = { model: undefined, systemPrompt: "", messages: [], tools: [] } as unknown as Parameters<
			NonNullable<ServerRuntimeExtension["contributeSamplingInput"]>
		>[0];
		const messages = await Promise.all(adapted.map((item) => item.contributeSamplingInput?.(context)));
		expect(messages.flat()).toEqual([
			{ role: "user", content: [{ type: "text", text: "one" }] },
			{ role: "user", content: [{ type: "text", text: "two" }] },
			{ role: "user", content: [{ type: "text", text: "three" }] },
		]);
		expect(adaptPiExtensionSampling({ path: "/project/extensions/ui.ts" } as unknown as Extension)).toEqual([]);
	});

	test("keeps later registrations available when one contributor rejects", async () => {
		const extension = {
			path: "/project/extensions/faulty.ts",
			samplingInputs: new Map([
				[
					"faulty",
					{
						id: "faulty",
						contribute: async () => {
							throw new Error("broken");
						},
					},
				],
				["healthy", { id: "healthy", contribute: () => ({ role: "user", content: "healthy", timestamp: 0 }) }],
			]),
		} as unknown as Extension;
		const [faulty, healthy] = adaptPiExtensionSampling(extension);
		const context = { model: undefined, messages: [] } as never;
		await expect(faulty!.contributeSamplingInput!(context)).rejects.toThrow("broken");
		expect(await healthy!.contributeSamplingInput!(context)).toEqual([
			{ role: "user", content: "healthy", timestamp: 0 },
		]);

		const host = new ServerRuntimeExtensionHost({ resolveModel: () => ({ id: "model" }) });
		for (const adapted of adaptPiExtensionSampling(extension)) await host.register(adapted);
		const collected = await host.collectSamplingInput(context);
		expect(collected.messages).toEqual([{ role: "user", content: "healthy", timestamp: 0 }]);
		expect(collected.outcomes).toEqual([
			{
				extensionId: "pi:/project/extensions/faulty.ts:sampling:faulty",
				status: "rejected",
				reason: expect.any(Error),
			},
			{ extensionId: "pi:/project/extensions/faulty.ts:sampling:healthy", status: "fulfilled" },
		]);
	});

	test("reports process-local resources instead of projecting them into the daemon", () => {
		const extension = {
			path: "/project/extensions/full.ts",
			tools: new Map([["tool", {}]]),
			commands: new Map([["command", {}]]),
			shortcuts: new Map([["ctrl+x", {}]]),
			flags: new Map([["flag", {}]]),
			messageRenderers: new Map([["message", {}]]),
			entryRenderers: new Map([["entry", {}]]),
			markdownTransformer: () => "",
			handlers: new Map([["turn_start", []]]),
			samplingInputs: new Map(),
		} as unknown as Extension;

		expect(inspectPiExtensionServerCompatibility(extension)).toEqual({
			extensionPath: "/project/extensions/full.ts",
			supported: [],
			unsupported: [
				"tools",
				"commands",
				"shortcuts",
				"flags",
				"message-renderers",
				"entry-renderers",
				"markdown-transformer",
				"lifecycle-handlers",
			],
		});
	});
});
