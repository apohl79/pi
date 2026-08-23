import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CodexPluginManifest } from "../src/core/codex-plugin.ts";
import { CodexPluginActivationStore } from "../src/core/codex-plugin-activation.ts";

async function createPlugin(version: string): Promise<{ root: string; manifest: CodexPluginManifest }> {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-activation-source-"));
	await mkdir(join(root, ".codex-plugin"), { recursive: true });
	const manifest = { name: "reviewer", version, skills: [], commands: [] } satisfies CodexPluginManifest;
	await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
	return { root, manifest };
}

async function createPluginWithResource(
	version: string,
	resource: string,
): Promise<{ root: string; manifest: CodexPluginManifest }> {
	const plugin = await createPlugin(version);
	await mkdir(join(plugin.root, resource), { recursive: true });
	const manifest = { ...plugin.manifest, skills: [resource] } satisfies CodexPluginManifest;
	await writeFile(join(plugin.root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
	return { root: plugin.root, manifest };
}

describe("CodexPluginActivationStore", () => {
	test("stages a version and atomically publishes the active pointer", async () => {
		const source = await createPlugin("1.0.0");
		const cache = await mkdtemp(join(tmpdir(), "pi-codex-activation-cache-"));
		const store = new CodexPluginActivationStore(cache);
		const result = await store.activate({
			id: "reviewer@local",
			version: source.manifest.version,
			sourceRoot: source.root,
			manifest: source.manifest,
		});

		expect(result).toMatchObject({ id: "reviewer@local", version: "1.0.0" });
		expect(await readFile(join(result.root, ".codex-plugin", "plugin.json"), "utf8")).toContain("1.0.0");
		expect(JSON.parse(await readFile(join(cache, result.root.split("/").at(-3)!, "active.json"), "utf8"))).toEqual({
			version: "1.0.0",
		});
	});

	test("switches versions without mutating the previous staged version", async () => {
		const first = await createPlugin("1.0.0");
		const second = await createPlugin("2.0.0");
		const cache = await mkdtemp(join(tmpdir(), "pi-codex-activation-upgrade-"));
		const store = new CodexPluginActivationStore(cache);
		const initial = await store.activate({
			id: "reviewer@local",
			version: "1.0.0",
			sourceRoot: first.root,
			manifest: first.manifest,
		});
		const upgraded = await store.activate({
			id: "reviewer@local",
			version: "2.0.0",
			sourceRoot: second.root,
			manifest: second.manifest,
		});

		expect(upgraded.previousVersion).toBe("1.0.0");
		expect(await readFile(join(initial.root, ".codex-plugin", "plugin.json"), "utf8")).toContain("1.0.0");
		await expect(access(join(upgraded.root, ".codex-plugin", "plugin.json"))).resolves.toBeUndefined();
	});

	test("rejects reactivating the current version and path-like versions", async () => {
		const source = await createPlugin("1.0.0");
		const cache = await mkdtemp(join(tmpdir(), "pi-codex-activation-invalid-"));
		const store = new CodexPluginActivationStore(cache);
		await store.activate({
			id: "reviewer@local",
			version: "1.0.0",
			sourceRoot: source.root,
			manifest: source.manifest,
		});
		await expect(
			store.activate({ id: "reviewer@local", version: "1.0.0", sourceRoot: source.root, manifest: source.manifest }),
		).rejects.toMatchObject({ code: "already_active" });
		await expect(
			store.activate({
				id: "reviewer@local",
				version: "../escape",
				sourceRoot: source.root,
				manifest: source.manifest,
			}),
		).rejects.toMatchObject({ code: "invalid_manifest" });
	});

	test("rejects incomplete packages before activating them", async () => {
		const source = await createPluginWithResource("1.0.0", "skills/review");
		const cache = await mkdtemp(join(tmpdir(), "pi-codex-activation-incomplete-"));
		await rm(join(source.root, "skills"), { recursive: true, force: true });
		const store = new CodexPluginActivationStore(cache);
		await expect(
			store.activate({
				id: "reviewer@local",
				version: source.manifest.version,
				sourceRoot: source.root,
				manifest: source.manifest,
			}),
		).rejects.toMatchObject({ code: "invalid_manifest" });
	});
});
