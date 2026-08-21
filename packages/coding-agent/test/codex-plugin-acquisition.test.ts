import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acquireCodexPlugin, CodexPluginAcquisitionError } from "../src/core/codex-plugin-acquisition.ts";

async function createPlugin(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-acquire-"));
	await mkdir(join(root, ".codex-plugin"), { recursive: true });
	await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "reviewer", version: "1.0.0" }));
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
});
