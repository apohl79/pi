import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	acquireCodexMarketplacePlugin,
	acquireCodexPlugin,
	CodexPluginAcquisitionError,
} from "../src/core/codex-plugin-acquisition.ts";

async function createPlugin(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-acquire-"));
	await mkdir(join(root, ".codex-plugin"), { recursive: true });
	await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "reviewer", version: "1.0.0" }));
	return root;
}

async function createMarketplace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-marketplace-"));
	const plugin = join(root, "plugins", "reviewer");
	await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
	await writeFile(
		join(plugin, ".codex-plugin", "plugin.json"),
		JSON.stringify({ name: "reviewer", version: "1.0.0" }),
	);
	await mkdir(join(root, ".agents", "plugins"), { recursive: true });
	await writeFile(
		join(root, ".agents", "plugins", "marketplace.json"),
		JSON.stringify({ plugins: [{ name: "reviewer", source: "plugins/reviewer" }] }),
	);
	return root;
}

describe("Codex plugin acquisition", () => {
	test("acquires a local plugin through the confined source boundary", async () => {
		const root = await createPlugin();
		const parent = join(root, "..");
		const result = await acquireCodexPlugin(root, { baseRoot: parent });
		expect(result).toMatchObject({ provenance: "local", source: root, manifest: { name: "reviewer" } });
	});

	test("delegates Git and npm sources without network side effects", async () => {
		const root = await createPlugin();
		const calls: string[] = [];
		const git = async (source: string) => {
			calls.push(source);
			return root;
		};
		const result = await acquireCodexPlugin("git+https://example.test/reviewer.git", { git });
		expect(result.provenance).toBe("git");
		expect(calls).toEqual(["git+https://example.test/reviewer.git"]);
	});

	test("fails explicitly when remote acquisition is not configured", async () => {
		await expect(acquireCodexPlugin("npm:@example/reviewer")).rejects.toMatchObject({
			name: CodexPluginAcquisitionError.name,
			code: "unsupported_source",
		});
	});

	test("resolves a local plugin through its marketplace manifest", async () => {
		const root = await createMarketplace();
		const result = await acquireCodexMarketplacePlugin(root, "reviewer");
		expect(result).toMatchObject({ provenance: "local", manifest: { name: "reviewer", version: "1.0.0" } });
	});
});
