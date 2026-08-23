import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(root, "PACKAGE_COMPATIBILITY.json"), "utf8"));
const expected = new Set();
for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
	if (!entry.isDirectory() || entry.name === "session-backends") continue;
	try {
		await access(join(root, "packages", entry.name, "package.json"));
		expected.add(`packages/${entry.name}`);
	} catch {
		// A package directory without package.json is not a published workspace.
	}
}
expected.add("packages/session-backends/sqlite-node");

assert.deepEqual(Object.keys(manifest.packages).sort(), [...expected].sort());
for (const [path, entry] of Object.entries(manifest.packages)) {
	assert.ok(["stock-compatible extension", "fork-dependent extension", "fork core"].includes(entry.classification), path);
	assert.ok(entry.rationale.length > 0, path);
	assert.ok(entry.tests.length > 0, path);
	for (const testPath of entry.tests) await access(join(root, testPath));
}
