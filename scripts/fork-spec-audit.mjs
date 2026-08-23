import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRepositoryRoot(metaUrl) {
	return fileURLToPath(new URL("..", metaUrl));
}

const root = resolveRepositoryRoot(import.meta.url);

const requiredFiles = [
	"FORK_DELTA.md",
	"README.fork.md",
	"PACKAGE_COMPATIBILITY.json",
	"packages/protocol/test",
	"packages/server/test/v2-conformance.test.ts",
	"packages/coding-agent/src/server/extension-host.ts",
	"packages/coding-agent/src/server/daemon-runtime.ts",
	"packages/coding-agent/src/client/server-sdk.ts",
	"packages/coding-agent/test/server/daemon-three-provider-routing.test.ts",
	"packages/coding-agent/test/server/daemon-plugin-e2e.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-scenario-goal-agent-input.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-pty-reattach.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-unsafe-recovery.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-rollback.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-name-race.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-files.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-diagnostics.test.ts",
	"packages/coding-agent/test/server/daemon-compaction-policy.test.ts",
	"packages/coding-agent/test/server/daemon-agent-restart.test.ts",
	"packages/coding-agent/test/server/daemon-unsafe-tool-recovery.test.ts",
	"packages/coding-agent/test/server/daemon-disk-full.test.ts",
	"packages/coding-agent/test/server/daemon-migration.test.ts",
	"packages/coding-agent/test/server/daemon-model-instructions.test.ts",
	"packages/coding-agent/test/server/daemon-rpc-session-name.test.ts",
	"packages/coding-agent/test/server/daemon-rollback-invariants.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-statusline.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-usage.test.ts",
];

const requiredPatterns = [
	["server-default SDK export", "packages/coding-agent/src/index.ts", "createServerAgentSession as createAgentSession"],
	["CLI server-default routing", "packages/coding-agent/src/cli.ts", "serverDefaultInteractive"],
	["server extension lifecycle", "packages/coding-agent/src/server/extension-host.ts", "ServerRuntimeExtensionHost"],
	["v2 protocol conformance", "packages/server/test/v2-conformance.test.ts", "describe("],
	["fork-core rationale ledger", "FORK_DELTA.md", "existing extension surface cannot"],
	["package compatibility classifications", "PACKAGE_COMPATIBILITY.json", '"classification"'],
	["fork build identity", "FORK_DELTA.md", "Runtime build identity in diagnostics"],
	["server-default CLI modes", "packages/coding-agent/src/cli.ts", "serverDefaultPrint"],
	["six agent tools", "packages/coding-agent/src/server/create-harness.ts", 'name: "interrupt_agent"'],
	["diagnostic bundle export", "packages/server/src/diagnostics.ts", "verifyDiagnosticBundle"],
	["unsafe recovery evidence", "packages/coding-agent/test/server/daemon-unsafe-tool-recovery.test.ts", "replay"],
	["model-specific compaction evidence", "packages/coding-agent/test/server/daemon-compaction-policy.test.ts", "model"],
	["rollback evidence", "packages/coding-agent/test/server/daemon-rollback-invariants.test.ts", "rollback"],
	["statusline evidence", "packages/coding-agent/test/client/remote-v2-production-statusline.test.ts", "statusline"],
	["usage evidence", "packages/coding-agent/test/client/remote-v2-production-usage.test.ts", "cost"],
];

export function auditForkSpec() {
	const failures = [];
	for (const path of requiredFiles) {
		if (!existsSync(join(root, path))) failures.push(`missing evidence path: ${path}`);
	}
	for (const [label, path, pattern] of requiredPatterns) {
		const absolute = join(root, path);
		if (!existsSync(absolute) || !readFileSync(absolute, "utf8").includes(pattern)) {
			failures.push(`missing evidence pattern (${label}): ${path}`);
		}
	}
	const manifest = JSON.parse(readFileSync(join(root, "PACKAGE_COMPATIBILITY.json"), "utf8"));
	for (const [path, entry] of Object.entries(manifest.packages ?? {})) {
		if (!entry.classification || !entry.rationale || !Array.isArray(entry.tests) || entry.tests.length === 0) {
			failures.push(`incomplete package compatibility entry: ${path}`);
		}
	}
	return { failures, checkedFiles: requiredFiles.length, checkedPatterns: requiredPatterns.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = auditForkSpec();
	console.log(`Fork spec evidence: ${result.checkedFiles} files, ${result.checkedPatterns} patterns`);
	if (result.failures.length > 0) {
		for (const failure of result.failures) console.error(`FAIL: ${failure}`);
		process.exitCode = 1;
	} else {
		console.log("Fork spec evidence audit passed");
	}
}
