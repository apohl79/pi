#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { parseArgs } from "./cli/args.ts";
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
	const jsonMode = args.some((arg, index) => arg === "--mode" && args[index + 1] === "json");
	const serverDefaultPrint =
		!args.includes("--no-server") && (args.includes("--print") || args.includes("-p") || jsonMode);
	if (!isExperimentalCommand(args) && !serverDefaultPrint) {
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
		compaction: (selectedModel) => {
			const override = modelRuntime.getCompactionOverride(selectedModel.provider, selectedModel.id);
			return {
				...DEFAULT_COMPACTION_SETTINGS,
				...(override === undefined
					? {}
					: { modelOverrides: { [`${selectedModel.provider}/${selectedModel.id}`]: override } }),
			};
		},
		socketPath: join(agentDir, "pi.sock"),
		write: (value) => console.log(JSON.stringify(value)),
		writeText: (value) => process.stdout.write(`${value}\n`),
	});
	try {
		if (serverDefaultPrint) await runtime.cli.runPi({ command: "pi", options: parseArgs(args) });
		else await main(args, { experimentalCliContext: runtime.cli });
	} finally {
		await runtime.close();
	}
}

void runCli().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
