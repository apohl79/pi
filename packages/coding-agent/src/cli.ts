#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { isServerDefaultCompatible, parseArgs } from "./cli/args.ts";
import { dispatchExperimentalCommand, isExperimentalCommand } from "./cli/experimental/dispatch.ts";
import { RemoteV2InteractiveAttachment } from "./client/remote-v2-interactive.ts";
import { RemoteV2SessionView, RemoteV2StatuslineComponent } from "./client/remote-v2-view.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./core/defaults.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { main } from "./main.ts";
import { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
import { SettingsSelectorComponent } from "./modes/interactive/components/settings-selector.ts";
import { createInteractiveTui } from "./modes/interactive/interactive-mode.ts";
import { getAvailableThemes, getEditorTheme, initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
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

type DetachedServerStatus = Readonly<{ serverId: string; pid: number; addresses: readonly string[] }>;

function detachedServerStatus(agentDir: string): DetachedServerStatus | undefined {
	const socketPath = join(agentDir, "pi.sock");
	try {
		const marker = JSON.parse(readFileSync(join(agentDir, "daemon-state.json"), "utf8")) as Partial<{
			daemonInstanceId: string;
			state: string;
			pid: number;
		}>;
		const pid = marker.pid;
		if (
			marker.state !== "running" ||
			typeof marker.daemonInstanceId !== "string" ||
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			!existsSync(socketPath)
		)
			return undefined;
		process.kill(pid, 0);
		return { serverId: marker.daemonInstanceId, pid, addresses: [socketPath] };
	} catch {
		return undefined;
	}
}

const waitForDetachedServer = async (agentDir: string, pid: number): Promise<DetachedServerStatus> => {
	for (let attempt = 0; attempt < 50; attempt++) {
		const status = detachedServerStatus(agentDir);
		if (status?.pid === pid) return status;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Detached server did not become ready");
};

async function runCli(): Promise<void> {
	const args = process.argv.slice(2);
	const foregroundServer = args[0] === "server" && args[1] === "start" && args.includes("--foreground");
	if (args[0] === "server" && args[1] === "start" && !args.includes("--foreground")) {
		const agentDir = getAgentDir();
		const running = detachedServerStatus(agentDir);
		if (running !== undefined) {
			console.log(JSON.stringify({ state: "running", ...running }));
			return;
		}
		const entrypoint = process.argv[1];
		if (entrypoint === undefined) throw new Error("Cannot determine CLI entrypoint for detached server");
		const child = spawn(process.execPath, [...process.execArgv, entrypoint, ...args, "--foreground"], {
			detached: true,
			stdio: "ignore",
		});
		if (child.pid === undefined) throw new Error("Failed to start detached server process");
		child.unref();
		console.log(JSON.stringify({ state: "running", ...(await waitForDetachedServer(agentDir, child.pid)) }));
		return;
	}
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
		await main(args.filter((arg) => arg !== "--no-server"));
		return;
	}
	const agentDir = getAgentDir();
	const statuslineSettings = SettingsManager.create(process.cwd(), agentDir);
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
	const availableModels = await modelRuntime.getAvailable();
	const model = availableModels[0];
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
			const keybindings = KeybindingsManager.create(agentDir);
			initTheme(statuslineSettings.getTheme(), true);
			const tui = createInteractiveTui({
				tuiMode: options.tuiMode ?? "regular",
				showHardwareCursor: false,
				logDirectory: agentDir,
			});
			const editor = new CustomEditor(tui, getEditorTheme(), keybindings);
			const view = new RemoteV2SessionView(session, { onUpdated: () => tui?.requestRender() });
			let statusline: RemoteV2StatuslineComponent;
			let attachment: RemoteV2InteractiveAttachment;
			const showSettings = () => {
				const snapshot = session.snapshot;
				const currentModel = availableModels.find(
					(candidate) => candidate.provider === snapshot?.model.provider && candidate.id === snapshot?.model.id,
				);
				const done = () => {
					tui.removeChild(selector);
					tui.removeChild(statusline);
					tui.addChild(attachment);
					tui.addChild(statusline);
					tui.setFocus(attachment);
					tui.requestRender();
				};
				const defaultProvider = statuslineSettings.getDefaultProvider();
				const defaultModelId = statuslineSettings.getDefaultModel();
				const defaultModel = defaultProvider && defaultModelId ? `${defaultProvider}/${defaultModelId}` : "not set";
				const selector = new SettingsSelectorComponent(
					{
						autoCompact: snapshot?.compactionPolicy.enabled ?? true,
						defaultModel,
						currentModel,
						availableDefaultModels: availableModels,
						showImages: statuslineSettings.getShowImages(),
						imageWidthCells: statuslineSettings.getImageWidthCells(),
						autoResizeImages: statuslineSettings.getImageAutoResize(),
						blockImages: statuslineSettings.getBlockImages(),
						enableSkillCommands: statuslineSettings.getEnableSkillCommands(),
						steeringMode: snapshot?.steeringMode ?? "all",
						followUpMode: snapshot?.followUpMode ?? "all",
						transport: statuslineSettings.getTransport(),
						httpIdleTimeoutMs: statuslineSettings.getHttpIdleTimeoutMs(),
						thinkingLevel: snapshot?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
						availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
						modelThinkingLevels: statuslineSettings.getAllModelThinkingLevels(),
						currentTheme: statuslineSettings.getTheme(),
						terminalTheme: "dark",
						availableThemes: getAvailableThemes(),
						hideThinkingBlock: statuslineSettings.getHideThinkingBlock(),
						mermaidRenderingMode: statuslineSettings.getMermaidRenderingMode(),
						showCacheMissNotices: statuslineSettings.getShowCacheMissNotices(),
						collapseChangelog: statuslineSettings.getCollapseChangelog(),
						enableInstallTelemetry: statuslineSettings.getEnableInstallTelemetry(),
						doubleEscapeAction: statuslineSettings.getDoubleEscapeAction(),
						treeFilterMode: statuslineSettings.getTreeFilterMode(),
						showHardwareCursor: statuslineSettings.getShowHardwareCursor(),
						editorPaddingX: statuslineSettings.getEditorPaddingX(),
						outputPad: statuslineSettings.getOutputPad(),
						autocompleteMaxVisible: statuslineSettings.getAutocompleteMaxVisible(),
						quietStartup: statuslineSettings.getQuietStartup(),
						defaultProjectTrust: statuslineSettings.getDefaultProjectTrust(),
						clearOnShrink: statuslineSettings.getClearOnShrink(),
						showTerminalProgress: statuslineSettings.getShowTerminalProgress(),
						tuiMode: tui.mode,
						fullscreenExitOutput: statuslineSettings.getFullscreenExitOutput(),
						fullscreenScrollbar: statuslineSettings.getFullscreenScrollbar(),
						warnings: statuslineSettings.getWarnings(),
					},
					{
						onAutoCompactChange: (enabled) => void session.setAutoCompaction(enabled).catch(() => undefined),
						onShowImagesChange: (enabled) => statuslineSettings.setShowImages(enabled),
						onImageWidthCellsChange: (width) => statuslineSettings.setImageWidthCells(width),
						onAutoResizeImagesChange: (enabled) => statuslineSettings.setImageAutoResize(enabled),
						onBlockImagesChange: (blocked) => statuslineSettings.setBlockImages(blocked),
						onEnableSkillCommandsChange: (enabled) => statuslineSettings.setEnableSkillCommands(enabled),
						onSteeringModeChange: (mode) => void session.setSteeringMode(mode).catch(() => undefined),
						onFollowUpModeChange: (mode) => void session.setFollowUpMode(mode).catch(() => undefined),
						onTransportChange: (transport) => statuslineSettings.setTransport(transport),
						onHttpIdleTimeoutMsChange: (timeoutMs) => {
							statuslineSettings.setHttpIdleTimeoutMs(timeoutMs);
							configureHttpDispatcher(timeoutMs);
						},
						onModelThinkingLevelChange: (provider, modelId, level) => {
							statuslineSettings.setModelThinkingLevel(provider, modelId, level);
							if (snapshot?.model.provider === provider && snapshot.model.id === modelId)
								void session.setThinking(level).catch(() => undefined);
						},
						onModelThinkingLevelRemove: (provider, modelId) =>
							statuslineSettings.removeModelThinkingLevel(provider, modelId),
						onThemeChange: (themeSetting) => {
							statuslineSettings.setTheme(themeSetting);
							initTheme(themeSetting, true);
						},
						onHideThinkingBlockChange: (hidden) => statuslineSettings.setHideThinkingBlock(hidden),
						onMermaidRenderingModeChange: (mode) => statuslineSettings.setMermaidRenderingMode(mode),
						onShowCacheMissNoticesChange: (shown) => statuslineSettings.setShowCacheMissNotices(shown),
						onCollapseChangelogChange: (collapsed) => statuslineSettings.setCollapseChangelog(collapsed),
						onEnableInstallTelemetryChange: (enabled) => statuslineSettings.setEnableInstallTelemetry(enabled),
						onDoubleEscapeActionChange: (action) => statuslineSettings.setDoubleEscapeAction(action),
						onTreeFilterModeChange: (mode) => statuslineSettings.setTreeFilterMode(mode),
						onShowHardwareCursorChange: (enabled) => {
							statuslineSettings.setShowHardwareCursor(enabled);
							tui.setShowHardwareCursor(enabled);
						},
						onEditorPaddingXChange: (padding) => {
							statuslineSettings.setEditorPaddingX(padding);
							editor.setPaddingX(padding);
						},
						onOutputPadChange: (padding) => statuslineSettings.setOutputPad(padding),
						onAutocompleteMaxVisibleChange: (maxVisible) => {
							statuslineSettings.setAutocompleteMaxVisible(maxVisible);
							editor.setAutocompleteMaxVisible(maxVisible);
						},
						onQuietStartupChange: (enabled) => statuslineSettings.setQuietStartup(enabled),
						onDefaultProjectTrustChange: (value) => statuslineSettings.setDefaultProjectTrust(value),
						onClearOnShrinkChange: (enabled) => {
							statuslineSettings.setClearOnShrink(enabled);
							tui.setClearOnShrink(enabled);
						},
						onShowTerminalProgressChange: (enabled) => statuslineSettings.setShowTerminalProgress(enabled),
						onTuiModeChange: (mode) => statuslineSettings.setTuiMode(mode),
						onFullscreenExitOutputChange: (output) => statuslineSettings.setFullscreenExitOutput(output),
						onFullscreenScrollbarChange: (scrollbar) => statuslineSettings.setFullscreenScrollbar(scrollbar),
						onWarningsChange: (warnings) => statuslineSettings.setWarnings(warnings),
						onCancel: done,
					},
				);
				tui.removeChild(attachment);
				tui.removeChild(statusline);
				tui.addChild(selector);
				tui.addChild(statusline);
				tui.setFocus(selector.getSettingsList());
				tui.requestRender();
			};
			attachment = new RemoteV2InteractiveAttachment(
				{
					session,
					view,
					setStatusline: async (command) => {
						statuslineSettings.setStatusLineCommand(command);
						await statusline.setCommand(command);
					},
					dispose: async () => view.dispose(),
				},
				editor,
				{ openSettings: showSettings },
			);
			statusline = new RemoteV2StatuslineComponent(
				session,
				new StatuslineRunner(),
				{ cwd: process.cwd(), transcriptPath: "", projectDir: process.cwd() },
				() => tui?.requestRender(),
			);
			await statusline.setCommand(statuslineSettings.getStatusLineCommand());
			tui.addChild(attachment);
			tui.addChild(statusline);
			tui.setFocus(attachment);
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					process.stdin.off("end", finish);
					tui.stop();
					void attachment.dispose().finally(() => {
						statusline.dispose();
						stopThemeWatcher();
						resolve();
					});
				};
				editor.onAction("app.clear", () => {
					if (editor.getText().length === 0) finish();
					else editor.setText("");
				});
				editor.onCtrlD = () => {
					if (session.phase === "turn") finish();
				};
				process.stdin.once("end", finish);
				tui.start();
			});
		},
	});
	if (foregroundServer) {
		try {
			await dispatchExperimentalCommand(args, runtime.cli);
			await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
		} finally {
			await runtime.close();
		}
		return;
	}
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
