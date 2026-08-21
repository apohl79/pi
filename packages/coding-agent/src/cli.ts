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
import { RemoteV2InteractiveAttachment } from "./client/remote-v2-interactive.ts";
import { RemoteV2SessionView } from "./client/remote-v2-view.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { main } from "./main.ts";
import { createInteractiveTui } from "./modes/interactive/interactive-mode.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "./server/daemon-runtime.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

const LEGACY_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);

async function runCli(): Promise<void> {
	const args = process.argv.slice(2);
	const jsonMode = args.some((arg, index) => arg === "--mode" && args[index + 1] === "json");
	const rpcMode = args.some((arg, index) => arg === "--mode" && args[index + 1] === "rpc");
	const serverDefaultPrint =
		!args.includes("--no-server") && (args.includes("--print") || args.includes("-p") || jsonMode);
	const serverDefaultInteractive =
		!args.includes("--no-server") &&
		!isExperimentalCommand(args) &&
		!serverDefaultPrint &&
		!rpcMode &&
		!args.some((arg) => arg.startsWith("-") || arg.startsWith("@")) &&
		!args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") &&
		(args.length === 0 || !LEGACY_COMMANDS.has(args[0]!));
	if (!isExperimentalCommand(args) && !serverDefaultPrint && !serverDefaultInteractive) {
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
		runInteractive: async (session, options) => {
			const view = new RemoteV2SessionView(session);
			const attachment = new RemoteV2InteractiveAttachment({ session, view, dispose: async () => view.dispose() });
			const tui = createInteractiveTui({
				tuiMode: options.tuiMode ?? "regular",
				showHardwareCursor: false,
				logDirectory: agentDir,
			});
			tui.addChild(attachment);
			tui.setFocus(attachment);
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					removeInputListener();
					process.stdin.off("end", finish);
					tui.stop();
					void attachment.dispose().finally(resolve);
				};
				const inputListener = (data: string) => {
					if (data === "\u0003") {
						finish();
						return { consume: true };
					}
					attachment.handleInput(data);
					return { consume: true };
				};
				const removeInputListener = tui.addInputListener(inputListener);
				process.stdin.once("end", finish);
				tui.start();
				void (async () => {
					for (const message of options.messages) await session.submit(message);
				})();
			});
		},
	});
	try {
		if (serverDefaultPrint || serverDefaultInteractive)
			await runtime.cli.runPi({ command: "pi", options: parseArgs(args) });
		else await main(args, { experimentalCliContext: runtime.cli });
	} finally {
		await runtime.close();
	}
}

void runCli().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
