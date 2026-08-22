import { InMemoryV2PluginRegistry } from "@earendil-works/pi-server";
import { describe, expect, test } from "vitest";
import { AcquiringV2PluginRegistry } from "../../src/server/plugin-registry.ts";

describe("AcquiringV2PluginRegistry", () => {
	test("resolves a manifest-less install from the selected marketplace", async () => {
		const delegate = new InMemoryV2PluginRegistry();
		await delegate.addMarketplace("local", "/workspace/marketplace");
		const registry = new AcquiringV2PluginRegistry(delegate, async (marketplace, pluginName) => {
			expect(marketplace.source).toBe("/workspace/marketplace");
			expect(pluginName).toBe("reviewer");
			return {
				root: "/workspace/cache/reviewer",
				manifest: { name: "reviewer", version: "1.0.0", skills: [], commands: [] },
			};
		});

		const installed = await registry.installPlugin({ name: "reviewer", marketplace: "local", version: "1.0.0" });
		expect(installed).toMatchObject({
			id: "reviewer@local",
			root: "/workspace/cache/reviewer",
			provenance: "manifest",
		});
	});

	test("resolves a manifest-less upgrade from the installed plugin marketplace", async () => {
		const delegate = new InMemoryV2PluginRegistry();
		await delegate.addMarketplace("local", "/workspace/marketplace");
		await delegate.installPlugin({
			name: "reviewer",
			marketplace: "local",
			version: "1.0.0",
			manifest: { name: "reviewer", version: "1.0.0", skills: [], commands: [] },
		});
		const registry = new AcquiringV2PluginRegistry(delegate, async (_marketplace, pluginName) => ({
			root: `/workspace/cache/${pluginName}`,
			manifest: { name: pluginName, version: "2.0.0", skills: [], commands: [] },
		}));

		const upgraded = await registry.upgradePlugin("reviewer@local", "2.0.0");
		expect(upgraded).toMatchObject({ id: "reviewer@local", version: "2.0.0", root: "/workspace/cache/reviewer" });
	});
});
