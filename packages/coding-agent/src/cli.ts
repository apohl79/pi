#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { join } from "node:path";
import { isExperimentalCommand } from "./cli/experimental/dispatch.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { main } from "./main.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "./server/daemon-runtime.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

async function runCli(): Promise<void> {
	const args = process.argv.slice(2);
	if (!isExperimentalCommand(args)) {
		await main(args);
		return;
	}
	const agentDir = getAgentDir();
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
	const model = modelRuntime.getModels()[0];
	if (model === undefined) throw new Error("No configured model is available for the experimental daemon");
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		agentDir,
		cwd: process.cwd(),
		models: modelRuntime,
		model,
		socketPath: join(agentDir, "pi.sock"),
		write: (value) => console.log(JSON.stringify(value)),
	});
	try {
		await main(args, { experimentalCliContext: runtime.cli });
	} finally {
		await runtime.close();
	}
}

void runCli().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
