import { describe, expect, test } from "vitest";
import { InMemoryV2PluginRegistry } from "../src/plugins.ts";

describe("InMemoryV2PluginRegistry", () => {
	test("tracks marketplace and plugin lifecycle with manifest provenance", async () => {
		const registry = new InMemoryV2PluginRegistry();
		await registry.addMarketplace("local", "/workspace/plugins");
		const plugin = await registry.installPlugin({
			name: "reviewer",
			marketplace: "local",
			version: "1.2.0",
			root: "/workspace/plugins/reviewer",
			manifest: {
				name: "reviewer",
				version: "1.2.0",
				skills: ["skills/review"],
				commands: ["commands/review"],
				apps: [{ id: "tracker" }],
				hooks: { afterTurn: "hooks/after-turn" },
			},
		});

		expect(plugin).toMatchObject({
			id: "reviewer@local",
			manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			enabled: true,
			resources: { skills: ["skills/review"], commands: ["commands/review"], apps: 1, hooks: 1 },
		});
		expect(await registry.setEnabled(plugin.id, false, "project")).toMatchObject({
			enabled: false,
			scope: "project",
		});
		await registry.uninstallPlugin(plugin.id);
		await expect(registry.removeMarketplace("local")).resolves.toBeUndefined();
	});

	test("rejects removing a marketplace with installed plugins", async () => {
		const registry = new InMemoryV2PluginRegistry();
		await registry.addMarketplace("local", "/workspace/plugins");
		await registry.installPlugin({ name: "one", marketplace: "local", version: "1", manifest: {} });
		await expect(registry.removeMarketplace("local")).rejects.toThrow("installed plugins");
	});
});
