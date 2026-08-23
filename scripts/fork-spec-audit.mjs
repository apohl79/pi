import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRepositoryRoot(metaUrl) {
	return fileURLToPath(new URL("..", metaUrl));
}

function testFilesUnder(path) {
	if (!existsSync(path)) return [];
	if (statSync(path).isFile()) return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
		testFilesUnder(join(path, entry.name)),
	);
}

const root = resolveRepositoryRoot(import.meta.url);

const requiredFiles = [
	"FORK_DELTA.md",
	"README.fork.md",
	"PACKAGE_COMPATIBILITY.json",
	"scripts/build-binaries.sh",
	"scripts/create-source-archive.sh",
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
	"packages/coding-agent/test/client/remote-v2-production-goal-durability.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-plugin-sampling.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-rollback.test.ts",
	"packages/coding-agent/test/server/daemon-compaction-policy.test.ts",
	"packages/coding-agent/test/server/daemon-agent-restart.test.ts",
	"packages/coding-agent/test/server/daemon-model-instructions.test.ts",
	"packages/coding-agent/test/server/daemon-migration.test.ts",
	"packages/coding-agent/test/server/daemon-unsafe-tool-recovery.test.ts",
	"packages/coding-agent/test/server/daemon-disk-full.test.ts",
	"packages/coding-agent/test/server/daemon-model-instructions.test.ts",
	"packages/coding-agent/test/server/daemon-rpc-session-name.test.ts",
	"packages/coding-agent/test/server/daemon-rollback-invariants.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-statusline.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-usage.test.ts",
	"packages/coding-agent/test/client/remote-v2-production-web-image.test.ts",
];

const requiredPatterns = [
	["server-default SDK export", "packages/coding-agent/src/index.ts", "createServerAgentSession as createAgentSession"],
	["CLI server-default routing", "packages/coding-agent/src/cli.ts", "serverDefaultInteractive"],
	["server extension lifecycle", "packages/coding-agent/src/server/extension-host.ts", "ServerRuntimeExtensionHost"],
	["v2 protocol conformance", "packages/server/test/v2-conformance.test.ts", "describe("],
	["fork-core rationale ledger", "FORK_DELTA.md", "existing extension surface cannot"],
	["package compatibility classifications", "PACKAGE_COMPATIBILITY.json", '"classification"'],
	["fork build identity", "FORK_DELTA.md", "Runtime build identity in diagnostics"],
	["standalone build identity injection", "scripts/build-binaries.sh", "BUILD_IDENTITY_FILE"],
	["source archive build identity injection", "scripts/create-source-archive.sh", "upstream_base_commit="],
	["server-default CLI modes", "packages/coding-agent/src/cli.ts", "serverDefaultPrint"],
	["six agent tools", "packages/coding-agent/src/server/create-harness.ts", 'name: "interrupt_agent"'],
	["diagnostic bundle export", "packages/server/src/diagnostics.ts", "verifyDiagnosticBundle"],
	["offline diagnostic verification evidence", "packages/server/test/diagnostics.test.ts", "verifies an exported event bundle offline"],
	["diagnostic redaction evidence", "packages/server/test/diagnostics.test.ts", "redacts credential fields"],
	["unsafe recovery evidence", "packages/coding-agent/test/server/daemon-unsafe-tool-recovery.test.ts", "replay"],
	["model-specific compaction evidence", "packages/coding-agent/test/server/daemon-compaction-policy.test.ts", "model"],
	["rollback evidence", "packages/coding-agent/test/server/daemon-rollback-invariants.test.ts", "rollback"],
	["statusline evidence", "packages/coding-agent/test/client/remote-v2-production-statusline.test.ts", "statusline"],
	["usage evidence", "packages/coding-agent/test/client/remote-v2-production-usage.test.ts", "cost"],
	["detach and PTY reattach evidence", "packages/coding-agent/test/client/remote-v2-production-pty-reattach.test.ts", "reattach"],
	["goal and input continuation evidence", "packages/coding-agent/test/client/remote-v2-production-scenario-goal-agent-input.test.ts", "pendingInputRequestId"],
	["causal diagnostics evidence", "packages/coding-agent/test/client/remote-v2-production-diagnostics.test.ts", "causal bundle"],
	["filesystem reference evidence", "packages/coding-agent/test/client/remote-v2-production-files.test.ts", "filesystem references"],
	["goal durability evidence", "packages/coding-agent/test/client/remote-v2-production-goal-durability.test.ts", "restart"],
	["plugin sampling evidence", "packages/coding-agent/test/client/remote-v2-production-plugin-sampling.test.ts", "sampling"],
	["daemon restart evidence", "packages/coding-agent/test/server/daemon-agent-restart.test.ts", "rehydrates"],
	["child model profile evidence", "packages/coding-agent/test/server/daemon-model-instructions.test.ts", "root and child profiles independently"],
	["disk-full admission evidence", "packages/coding-agent/test/server/daemon-disk-full.test.ts", "disk-full"],
	["legacy migration evidence", "packages/coding-agent/test/server/daemon-migration.test.ts", "legacy"],
	["MCP exclusion evidence", "packages/coding-agent/test/client/remote-v2-production-plugins.test.ts", "unsupported MCP"],
	["rollback projection evidence", "packages/coding-agent/test/client/remote-v2-production-rollback.test.ts", "reconstructs"],
	["terminal snapshot evidence", "packages/tui/test/editor.test.ts", "undo snapshots"],
	["cross-platform TUI evidence", ".github/workflows/ci.yml", "@earendil-works/pi-tui"],
	["agent lifecycle state-machine evidence", "packages/server/test/agents.test.ts", "lifecycle state machine"],
	["v1 compatibility evidence", "packages/protocol/test/v2-contract.test.ts", "rejects v1 messages"],
	["storage publication-ordering evidence", "packages/session-backends/sqlite-node/test/repository.test.ts", "does not publish connection state when an append transaction fails"],
	["in-memory acceptance evidence", "packages/server/test/v2-conformance.test.ts", "connectInMemoryTestClientV2"],
	["faux-provider integration evidence", "packages/coding-agent/test/server/daemon-three-provider-routing.test.ts", "fauxProvider"],
	["plugin lifecycle evidence", "packages/coding-agent/test/server/daemon-plugin-e2e.test.ts", "exercises every supported resource"],
	["web tool evidence", "packages/coding-agent/test/server/daemon-web-tool.test.ts", "routes a model web tool call"],
	["image tool evidence", "packages/coding-agent/test/server/daemon-generate-image-tool.test.ts", "routes a model image-generation call"],
	["remote web and image evidence", "packages/coding-agent/test/client/remote-v2-production-web-image.test.ts", "routes web and image requests"],
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
	for (const line of readFileSync(join(root, "FORK_DELTA.md"), "utf8").split("\n")) {
		const classified =
			line.includes("| Stock-compatible extension |") ||
			line.includes("| Fork-dependent extension |") ||
			line.includes("| Fork core |");
		if (line.startsWith("|") && classified && !line.includes("Compatibility is covered")) {
			failures.push(`classified ledger row lacks compatibility evidence: ${line}`);
		}
	}
	const manifest = JSON.parse(readFileSync(join(root, "PACKAGE_COMPATIBILITY.json"), "utf8"));
	for (const [path, entry] of Object.entries(manifest.packages ?? {})) {
		if (!entry.classification || !entry.rationale || !Array.isArray(entry.tests) || entry.tests.length === 0) {
			failures.push(`incomplete package compatibility entry: ${path}`);
			continue;
		}
		for (const testPath of entry.tests) {
			if (typeof testPath !== "string" || !existsSync(join(root, testPath))) {
				failures.push(`missing compatibility test evidence: ${path} -> ${String(testPath)}`);
			} else if (testFilesUnder(join(root, testPath)).length === 0) {
				failures.push(`compatibility evidence contains no test file: ${path} -> ${testPath}`);
			}
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
