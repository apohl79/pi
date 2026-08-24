#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { isServerDefaultCompatible, parseArgs } from "./cli/args.ts";
import { isExperimentalCommand } from "./cli/experimental/dispatch.ts";
import { RemoteV2InteractiveAttachment } from "./client/remote-v2-interactive.ts";
import { RemoteV2SessionView, RemoteV2StatuslineComponent } from "./client/remote-v2-view.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { main } from "./main.ts";
import { createInteractiveTui } from "./modes/interactive/interactive-mode.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "./server/daemon-runtime.ts";
import { StatuslineRunner } from "./server/statusline.ts";

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
	const parsedArgs = parseArgs(args);
	const jsonMode = args.some((arg, index) => arg === "--mode" && args[index + 1] === "json");
	const rpcMode = args.some((arg, index) => arg === "--mode" && args[index + 1] === "rpc");
	const serverDefaultRpc = !args.includes("--no-server") && rpcMode && isServerDefaultCompatible(parsedArgs);
	const serverDefaultPrint =
		!args.includes("--no-server") &&
		(args.includes("--print") || args.includes("-p") || jsonMode) &&
		isServerDefaultCompatible(parsedArgs);
	const serverDefaultInteractive =
		!args.includes("--no-server") &&
		!isExperimentalCommand(args) &&
		!serverDefaultPrint &&
		!rpcMode &&
		isServerDefaultCompatible(parsedArgs) &&
		!args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v") &&
		(args.length === 0 || !LEGACY_COMMANDS.has(args[0]!));
	if (!isExperimentalCommand(args) && !serverDefaultPrint && !serverDefaultInteractive && !serverDefaultRpc) {
		await main(args);
		return;
	}
	const agentDir = getAgentDir();
	const statuslineSettings = SettingsManager.create(process.cwd(), agentDir);
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
	const model = modelRuntime.getModels()[0];
	if (model === undefined) throw new Error("No configured model is available for the experimental daemon");
	const harnessOptions =
		parsedArgs.systemPrompt === undefined &&
		parsedArgs.appendSystemPrompt === undefined &&
		parsedArgs.tools === undefined &&
		parsedArgs.noTools !== true &&
		parsedArgs.excludeTools === undefined &&
		parsedArgs.noBuiltinTools !== true &&
		parsedArgs.extensions === undefined &&
		parsedArgs.noExtensions !== true &&
		parsedArgs.skills === undefined &&
		parsedArgs.promptTemplates === undefined &&
		parsedArgs.noSkills !== true &&
		parsedArgs.noPromptTemplates !== true &&
		parsedArgs.noContextFiles !== true
			? undefined
			: {
					...(parsedArgs.systemPrompt === undefined && parsedArgs.appendSystemPrompt === undefined
						? {}
						: {
								systemPromptOptions: {
									...(parsedArgs.systemPrompt === undefined ? {} : { customPrompt: parsedArgs.systemPrompt }),
									...(parsedArgs.appendSystemPrompt === undefined
										? {}
										: { appendSystemPrompt: parsedArgs.appendSystemPrompt.join("\n\n") }),
								},
							}),
					...(parsedArgs.noTools === true
						? { activeToolNames: [] }
						: parsedArgs.tools === undefined
							? {}
							: { activeToolNames: [...parsedArgs.tools] }),
					...(parsedArgs.excludeTools === undefined ? {} : { excludedToolNames: [...parsedArgs.excludeTools] }),
					...(parsedArgs.noBuiltinTools === true ? { disableBuiltinTools: true } : {}),
				};
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
		fastModelResolver: (selectedModel) => modelRuntime.getModelRole(selectedModel.provider, "fast"),
		harness: harnessOptions,
		extensionPaths: parsedArgs.extensions,
		skillPaths: parsedArgs.skills,
		promptTemplatePaths: parsedArgs.promptTemplates,
		noExtensions: parsedArgs.noExtensions,
		noSkills: parsedArgs.noSkills,
		noPromptTemplates: parsedArgs.noPromptTemplates,
		noContextFiles: parsedArgs.noContextFiles,
		socketPath: join(agentDir, "pi.sock"),
		write: (value) => console.log(JSON.stringify(value)),
		writeText: (value) => process.stdout.write(`${value}\n`),
		runInteractive: async (session, options) => {
			let tui: ReturnType<typeof createInteractiveTui>;
			const view = new RemoteV2SessionView(session, { onUpdated: () => tui?.requestRender() });
			let statusline: RemoteV2StatuslineComponent;
			const attachment = new RemoteV2InteractiveAttachment({
				session,
				view,
				setStatusline: async (command) => {
					statuslineSettings.setStatusLineCommand(command);
					await statusline.setCommand(command);
				},
				dispose: async () => view.dispose(),
			});
			statusline = new RemoteV2StatuslineComponent(
				session,
				new StatuslineRunner(),
				{ cwd: process.cwd(), transcriptPath: "", projectDir: process.cwd() },
				() => tui?.requestRender(),
			);
			await statusline.setCommand(statuslineSettings.getStatusLineCommand());
			tui = createInteractiveTui({
				tuiMode: options.tuiMode ?? "regular",
				showHardwareCursor: false,
				logDirectory: agentDir,
			});
			tui.addChild(attachment);
			tui.addChild(statusline);
			tui.setFocus(attachment);
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					removeInputListener();
					process.stdin.off("end", finish);
					tui.stop();
					void attachment.dispose().finally(() => {
						statusline.dispose();
						resolve();
					});
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
			});
		},
	});
	try {
		if (serverDefaultRpc) await runtime.cli.runRpc(parsedArgs);
		else if (serverDefaultPrint || serverDefaultInteractive)
			await runtime.cli.runPi({ command: "pi", options: parsedArgs });
		else await main(args, { experimentalCliContext: runtime.cli });
	} finally {
		await runtime.close();
	}
}

void runCli().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
