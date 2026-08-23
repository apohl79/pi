import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	loadCodexMarketplaceManifest,
	loadCodexPluginManifest,
	parseCodexMarketplaceManifest,
	parseCodexPluginManifest,
	resolveCodexPluginResource,
	resolveCodexPluginResourceOnDisk,
	resolveLocalCodexMarketplacePlugin,
} from "../src/core/codex-plugin.ts";

describe("Codex plugin manifest compatibility", () => {
	test("normalizes supported resources and diagnoses MCP without launching it", () => {
		const result = parseCodexPluginManifest({
			name: "example-plugin",
			version: "1.2.3",
			description: "fixture",
			skills: "skills",
			commands: ["commands/review.md"],
			apps: [{ id: "calendar" }],
			mcpServers: { local: { command: "unsafe-server" } },
		});
		expect(result.manifest).toMatchObject({
			name: "example-plugin",
			version: "1.2.3",
			skills: ["skills"],
			commands: ["commands/review.md"],
		});
		expect(result.diagnostics).toEqual([
			{
				code: "unsupported_mcp_resource",
				severity: "warning",
				message: "MCP resources are not started by Pi; supported plugin resources may still activate",
			},
		]);
	});

	test("rejects malformed required fields", () => {
		const result = parseCodexPluginManifest({ name: "", skills: 42 });
		expect(result.manifest).toBeUndefined();
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"invalid_manifest",
			"invalid_manifest",
			"invalid_manifest",
		]);
	});

	test("keeps resource resolution beneath the declared plugin root", () => {
		expect(resolveCodexPluginResource("/plugins/example", "skills/review/SKILL.md")).toEqual({
			ok: true,
			path: "/plugins/example/skills/review/SKILL.md",
		});
		expect(resolveCodexPluginResource("/plugins/example", "../outside.ts")).toMatchObject({
			ok: false,
			code: "path_escape",
		});
		expect(resolveCodexPluginResource("/plugins/example", "/etc/passwd")).toMatchObject({
			ok: false,
			code: "absolute_path",
		});
	});

	test("rejects resources that escape through a symlinked path component", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-codex-plugin-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-codex-plugin-outside-"));
		try {
			await mkdir(join(root, "skills"));
			await writeFile(join(outside, "secret.md"), "secret");
			await symlink(outside, join(root, "skills", "shared"));

			expect(resolveCodexPluginResource(root, "skills/shared/secret.md")).toMatchObject({
				ok: false,
				code: "path_escape",
			});
		} finally {
			await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
		}
	});

	test("normalizes marketplace local, git, and npm plugin sources", () => {
		const result = parseCodexMarketplaceManifest({
			plugins: [
				{ name: "local-plugin", source: "./plugins/local" },
				{ name: "git-plugin", source: "git+https://github.com/example/plugin.git" },
				{ name: "npm-plugin", source: "npm:@example/plugin" },
			],
		});
		expect(result).toEqual({
			manifest: {
				plugins: [
					{ name: "local-plugin", source: { kind: "local", value: "./plugins/local" } },
					{ name: "git-plugin", source: { kind: "git", value: "git+https://github.com/example/plugin.git" } },
					{ name: "npm-plugin", source: { kind: "npm", value: "@example/plugin" } },
				],
			},
			diagnostics: [],
		});
	});

	test("discovers supported marketplace and plugin manifests from disk", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-codex-marketplace-"));
		const pluginRoot = join(root, "plugins", "reviewer");
		await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
		await mkdir(join(pluginRoot, "skills"), { recursive: true });
		await writeFile(
			join(pluginRoot, ".codex-plugin", "plugin.json"),
			JSON.stringify({
				name: "reviewer",
				version: "1.0.0",
				skills: ["skills"],
			}),
		);
		await mkdir(join(root, ".agents", "plugins"), { recursive: true });
		await writeFile(
			join(root, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({
				plugins: [{ name: "reviewer", source: "./plugins/reviewer" }],
			}),
		);

		const marketplace = await loadCodexMarketplaceManifest(root);
		expect(marketplace.manifest?.plugins).toEqual([
			{ name: "reviewer", source: { kind: "local", value: "./plugins/reviewer" } },
		]);
		const plugin = await resolveLocalCodexMarketplacePlugin(root, marketplace.manifest!.plugins[0]!);
		expect(plugin.manifest).toMatchObject({ name: "reviewer", version: "1.0.0" });
		expect((await loadCodexPluginManifest(plugin.root)).manifest?.name).toBe("reviewer");
	});

	test("rejects disk resources that escape through symlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-codex-plugin-root-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-codex-plugin-outside-"));
		await symlink(outside, join(root, "linked"));
		expect(await resolveCodexPluginResourceOnDisk(root, "linked")).toMatchObject({
			ok: false,
			code: "symlink_escape",
		});
	});
});
