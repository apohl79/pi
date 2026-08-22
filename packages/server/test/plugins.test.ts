import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InMemoryV2PluginRegistry, JsonV2PluginRegistry } from "../src/plugins.ts";

describe("InMemoryV2PluginRegistry", () => {
	test("tracks marketplace and plugin lifecycle with package provenance", async () => {
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
				context: {
					sampling: [
						{
							id: "reminder",
							slot: "contextual_user",
							position: "supplement",
							text: "Check project context",
							condition_shell: "true",
						},
					],
				},
			},
		});

		expect(plugin).toMatchObject({
			id: "reviewer@local",
			provenance: "package",
			manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			enabled: true,
			resources: { skills: ["skills/review"], commands: ["commands/review"], apps: 1, hooks: 1 },
			sampling: [
				{
					id: "reminder",
					slot: "contextual_user",
					position: "supplement",
					text: "Check project context",
					conditionShell: "true",
				},
			],
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

	test("rejects manifest identity conflicts on install and upgrade", async () => {
		const registry = new InMemoryV2PluginRegistry();
		await registry.addMarketplace("local", "/workspace/plugins");
		await expect(
			registry.installPlugin({
				name: "reviewer",
				marketplace: "local",
				version: "1",
				manifest: { name: "other", version: "1" },
			}),
		).rejects.toThrow("manifest name");
		await registry.installPlugin({
			name: "reviewer",
			marketplace: "local",
			version: "1",
			manifest: { name: "reviewer" },
		});
		await expect(registry.upgradePlugin("reviewer@local", "2", { name: "reviewer", version: "1" })).rejects.toThrow(
			"manifest version",
		);
	});

	test("recovers marketplace and plugin state after reopening", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-plugin-registry-"));
		const path = join(directory, "state", "plugins.json");
		const first = new JsonV2PluginRegistry(path);
		await first.addMarketplace("local", "/workspace/plugins");
		await first.installPlugin({
			name: "reviewer",
			marketplace: "local",
			version: "1",
			manifest: { skills: ["review"] },
		});
		await first.setEnabled("reviewer@local", false);

		const reopened = new JsonV2PluginRegistry(path);
		expect(await reopened.listMarketplaces()).toHaveLength(1);
		expect(await reopened.readPlugin("reviewer@local")).toMatchObject({ enabled: false, version: "1" });
		const persisted = JSON.parse(await readFile(path, "utf8")) as { plugins: unknown[] };
		expect(persisted.plugins).toHaveLength(1);
	});

	test("upgrades a plugin version and persists the registry change", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-plugin-registry-upgrade-"));
		const path = join(directory, "plugins.json");
		const registry = new JsonV2PluginRegistry(path);
		await registry.addMarketplace("local", "/workspace/plugins");
		await registry.installPlugin({ name: "reviewer", marketplace: "local", version: "1", manifest: {} });

		expect(await registry.upgradePlugin("reviewer@local", "2")).toMatchObject({
			version: "2",
			provenance: "manifest",
		});
		expect(
			await registry.upgradePlugin(
				"reviewer@local",
				"3",
				{ name: "reviewer", version: "3" },
				"/workspace/plugins/reviewer",
			),
		).toMatchObject({ version: "3", provenance: "package" });
		await expect(registry.upgradePlugin("reviewer@local", "  ")).rejects.toThrow("plugin version must not be empty");
		await expect(registry.upgradePlugin("missing@local", "2")).rejects.toThrow("Unknown plugin");

		const reopened = new JsonV2PluginRegistry(path);
		expect(await reopened.readPlugin("reviewer@local")).toMatchObject({ version: "3", provenance: "package" });
	});

	test("does not follow a temporary symlink when writing state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-plugin-registry-link-"));
		const path = join(directory, "plugins.json");
		const target = join(directory, "target.json");
		await symlink(target, path);
		const registry = new JsonV2PluginRegistry(path);
		await registry.addMarketplace("local", "/workspace/plugins");
		await expect(access(target)).rejects.toThrow();
	});

	test("rejects malformed persisted plugin records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-plugin-registry-invalid-"));
		const path = join(directory, "plugins.json");
		await writeFile(
			path,
			JSON.stringify({
				marketplaces: [{ name: "local", source: "/workspace/plugins", addedAt: 1 }],
				plugins: [{ id: "reviewer@local", name: "reviewer", enabled: "yes" }],
			}),
		);

		await expect(new JsonV2PluginRegistry(path).listPlugins()).rejects.toThrow(
			"Plugin registry plugin record is invalid",
		);
	});
});
