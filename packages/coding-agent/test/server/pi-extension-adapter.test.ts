import { describe, expect, test } from "vitest";
import type { Extension } from "../../src/core/extensions/types.ts";
import type { ServerRuntimeExtension } from "../../src/server/extension-host.ts";
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
		expect(adapted).toBeDefined();
		expect(adapted?.scope).toBe("server");
		expect(adapted?.capabilities).toEqual(["sampling-input"]);
		const context = { model: undefined, systemPrompt: "", messages: [], tools: [] } as unknown as Parameters<
			NonNullable<ServerRuntimeExtension["contributeSamplingInput"]>
		>[0];
		expect(await adapted?.contributeSamplingInput?.(context)).toEqual([
			{ role: "user", content: [{ type: "text", text: "one" }] },
			{ role: "user", content: [{ type: "text", text: "two" }] },
			{ role: "user", content: [{ type: "text", text: "three" }] },
		]);
		expect(adaptPiExtensionSampling({ path: "/project/extensions/ui.ts" } as unknown as Extension)).toBeUndefined();
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
