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
import { type AgentMessage, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/pi-protocol";
import { Container } from "@earendil-works/pi-tui";
import { isServerDefaultCompatible, parseArgs } from "./cli/args.ts";
import { dispatchExperimentalCommand, isExperimentalCommand } from "./cli/experimental/dispatch.ts";
import { RemoteV2InteractiveAttachment } from "./client/remote-v2-interactive.ts";
import { RemoteV2FooterComponent, RemoteV2SessionView, RemoteV2StatuslineComponent } from "./client/remote-v2-view.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./core/defaults.ts";
import { FooterDataProvider } from "./core/footer-data-provider.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import { resolveModelScopeFromModels } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import type { SessionEntry, SessionInfo, SessionTreeNode } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { main } from "./main.ts";
import { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
import { ExtensionEditorComponent } from "./modes/interactive/components/extension-editor.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { InteractiveLayout } from "./modes/interactive/components/interactive-layout.ts";
import { formatInteractiveTerminalTitle } from "./modes/interactive/components/interactive-title.ts";
import { ModelSelectorComponent } from "./modes/interactive/components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./modes/interactive/components/session-selector.ts";
import { SettingsSelectorComponent } from "./modes/interactive/components/settings-selector.ts";
import { ThinkingSelectorComponent } from "./modes/interactive/components/thinking-selector.ts";
import { TreeSelectorComponent } from "./modes/interactive/components/tree-selector.ts";
import { UserMessageSelectorComponent } from "./modes/interactive/components/user-message-selector.ts";
import { createInteractiveTui } from "./modes/interactive/interactive-mode.ts";
import { getAvailableThemes, getEditorTheme, initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { createConfiguredCodingAgentDaemonRuntime } from "./server/daemon-runtime.ts";
import { StatuslineRunner } from "./server/statusline.ts";
import { copyToClipboard } from "./utils/clipboard.ts";

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

function remoteTreeNodes(entries: readonly JsonValue[], labels: Readonly<Record<string, string>>): SessionTreeNode[] {
	const nodes = new Map<string, SessionTreeNode>();
	for (const value of entries) {
		const entry = remoteTreeEntry(value);
		if (entry !== undefined)
			nodes.set(entry.id, { entry, children: [], ...(labels[entry.id] ? { label: labels[entry.id] } : {}) });
	}
	const roots: SessionTreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.entry.parentId === null ? undefined : nodes.get(node.entry.parentId);
		if (parent === undefined) roots.push(node);
		else parent.children.push(node);
	}
	return roots;
}

function remoteTreeEntry(value: JsonValue): SessionEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (
		typeof entry.id !== "string" ||
		(entry.parentId !== null && typeof entry.parentId !== "string") ||
		typeof entry.timestamp !== "number" ||
		typeof entry.type !== "string"
	)
		return undefined;
	const base = { id: entry.id, parentId: entry.parentId, timestamp: new Date(entry.timestamp).toISOString() };
	switch (entry.type) {
		case "message":
			return typeof entry.message === "object" && entry.message !== null && !Array.isArray(entry.message)
				? { ...base, type: "message", message: entry.message as AgentMessage }
				: undefined;
		case "model_change":
			return typeof entry.provider === "string" && typeof entry.modelId === "string"
				? { ...base, type: "model_change", provider: entry.provider, modelId: entry.modelId }
				: undefined;
		case "thinking_level_change":
			return typeof entry.thinkingLevel === "string"
				? { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel }
				: undefined;
		case "compaction":
			return typeof entry.summary === "string" && typeof entry.tokensBefore === "number"
				? {
						...base,
						type: "compaction",
						summary: entry.summary,
						tokensBefore: entry.tokensBefore,
						firstKeptEntryId: "",
					}
				: undefined;
		case "branch_summary":
			return typeof entry.fromId === "string" && typeof entry.summary === "string"
				? { ...base, type: "branch_summary", fromId: entry.fromId, summary: entry.summary }
				: undefined;
		case "custom":
			return typeof entry.customType === "string"
				? {
						...base,
						type: "custom",
						customType: entry.customType,
						...(entry.data === undefined ? {} : { data: entry.data }),
					}
				: undefined;
		case "active_tools_change":
			return { ...base, type: "custom", customType: "active_tools_change" };
		default:
			return undefined;
	}
}

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
	let scopedModels = resolveModelScopeFromModels(
		statuslineSettings.getEnabledModels() ?? [],
		availableModels,
	).scopedModels;
	const model = scopedModels[0]?.model ?? availableModels[0];
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
			const updateTerminalTitle = () => {
				tui.terminal.setTitle(formatInteractiveTerminalTitle(process.cwd(), session.snapshot?.name));
			};
			const view = new RemoteV2SessionView(session, {
				tui,
				cwd: process.cwd(),
				onUpdated: () => {
					updateTerminalTitle();
					tui.requestRender();
				},
				getHideThinkingBlock: () => statuslineSettings.getHideThinkingBlock(),
				getOutputPad: () => statuslineSettings.getOutputPad(),
				getShowImages: () => statuslineSettings.getShowImages(),
				getImageWidthCells: () => statuslineSettings.getImageWidthCells(),
			});
			updateTerminalTitle();
			const transcriptContainer = new Container();
			const pendingContainer = new Container();
			const statusContainer = new Container();
			const aboveEditorContainer = new Container();
			const editorContainer = new Container();
			editorContainer.addChild(editor);
			const belowEditorContainer = new Container();
			const footerContainer = new Container();
			const footerData = new FooterDataProvider(process.cwd());
			footerData.setAvailableProviderCount(new Set(availableModels.map((candidate) => candidate.provider)).size);
			const footer = new RemoteV2FooterComponent(session, footerData, process.cwd());
			footerContainer.addChild(footer);
			const restoreTranscript = () => {
				transcriptContainer.clear();
				transcriptContainer.addChild(view);
				tui.setFocus(editor);
				tui.requestRender();
			};
			restoreTranscript();
			let statusline: RemoteV2StatuslineComponent;
			let attachment: RemoteV2InteractiveAttachment;
			const setSelectedModel = async (
				selected: (typeof availableModels)[number],
				persist: boolean,
			): Promise<void> => {
				const scopedThinking = scopedModels.find(
					(scoped) => scoped.model.provider === selected.provider && scoped.model.id === selected.id,
				)?.thinkingLevel;
				const thinking =
					scopedThinking ??
					statuslineSettings.getModelThinkingLevel(selected.provider, selected.id) ??
					statuslineSettings.getDefaultThinkingLevel() ??
					DEFAULT_THINKING_LEVEL;
				const modelOperation = await session.setModel({ provider: selected.provider, id: selected.id });
				await session.waitForOperation(modelOperation);
				const thinkingOperation = await session.setThinking(thinking);
				await session.waitForOperation(thinkingOperation);
				if (persist) statuslineSettings.setDefaultModelAndProvider(selected.provider, selected.id);
				footer.invalidate();
				view.showStatus(`Model: ${selected.name || selected.id}`);
			};
			const showModel = () => {
				const snapshot = session.snapshot;
				const currentModel = availableModels.find(
					(candidate) => candidate.provider === snapshot?.model.provider && candidate.id === snapshot?.model.id,
				);
				const done = () => {
					restoreTranscript();
				};
				const selectModel = (selected: (typeof availableModels)[number], persist: boolean) =>
					void setSelectedModel(selected, persist).then(done, done);
				const defaultProvider = statuslineSettings.getDefaultProvider();
				const defaultModelId = statuslineSettings.getDefaultModel();
				const selector = new ModelSelectorComponent(
					tui,
					currentModel,
					modelRuntime,
					scopedModels,
					(selected) => selectModel(selected, false),
					done,
					undefined,
					(selected) => selectModel(selected, true),
					defaultProvider && defaultModelId ? { provider: defaultProvider, id: defaultModelId } : undefined,
				);
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector);
				tui.requestRender();
			};
			const showScopedModels = () => {
				const configuredPatterns = statuslineSettings.getEnabledModels();
				const configuredIds = (patterns: string[] | undefined): string[] | null => {
					if (!patterns || patterns.length === 0) return null;
					return resolveModelScopeFromModels(patterns, availableModels).scopedModels.map(
						(scoped) => `${scoped.model.provider}/${scoped.model.id}`,
					);
				};
				let enabledIds = configuredIds(configuredPatterns);
				const applyScope = (nextIds: string[] | null) => {
					enabledIds = nextIds === null ? null : [...nextIds];
					scopedModels =
						enabledIds === null ? [] : resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
					tui.requestRender();
				};
				const done = () => restoreTranscript();
				const selector = new ScopedModelsSelectorComponent(
					{ allModels: availableModels, enabledModelIds: enabledIds },
					{
						onChange: applyScope,
						onPersist: (nextIds) => {
							const allEnabled =
								nextIds !== null &&
								nextIds.length === availableModels.length &&
								nextIds.every((id) => availableModels.some((model) => `${model.provider}/${model.id}` === id));
							statuslineSettings.setEnabledModels(nextIds === null || allEnabled ? undefined : [...nextIds]);
							view.showStatus("Model selection saved to settings");
						},
						onCancel: done,
					},
				);
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector);
				tui.requestRender();
			};
			const showThinking = () => {
				const done = () => restoreTranscript();
				const selectThinking = (level: (typeof THINKING_LEVEL_OPTIONS)[number], persist: boolean) => {
					void session
						.setThinking(level)
						.then(() => {
							if (persist) statuslineSettings.setDefaultThinkingLevel(level);
							view.showStatus(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
							done();
						})
						.catch((error: unknown) => {
							view.showStatus(error instanceof Error ? error.message : String(error));
							done();
						});
				};
				const selector = new ThinkingSelectorComponent(
					session.snapshot?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
					[...THINKING_LEVEL_OPTIONS],
					(level) => selectThinking(level, false),
					done,
					(level) => selectThinking(level, true),
					statuslineSettings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
				);
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector);
				tui.requestRender();
			};
			const cycleThinking = () => {
				const current = session.snapshot?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
				const currentIndex = THINKING_LEVEL_OPTIONS.indexOf(current);
				const next = THINKING_LEVEL_OPTIONS[(currentIndex + 1) % THINKING_LEVEL_OPTIONS.length]!;
				void session
					.setThinking(next)
					.then(() => view.showStatus(`Thinking level: ${next}`))
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
			};
			const cycleModel = (direction: "forward" | "backward") => {
				const cycleModels =
					scopedModels.length === 0 ? availableModels : scopedModels.map((scoped) => scoped.model);
				if (cycleModels.length < 2) {
					view.showStatus(scopedModels.length === 0 ? "Only one model available" : "Only one model in scope");
					return;
				}
				const snapshot = session.snapshot;
				const selectedIndex = cycleModels.findIndex(
					(candidate) => candidate.provider === snapshot?.model.provider && candidate.id === snapshot?.model.id,
				);
				const currentIndex = selectedIndex === -1 ? 0 : selectedIndex;
				const nextIndex =
					direction === "forward"
						? (currentIndex + 1) % cycleModels.length
						: (currentIndex + cycleModels.length - 1) % cycleModels.length;
				const next = cycleModels[nextIndex]!;
				void setSelectedModel(next, false)
					.then(() => view.showStatus(`Switched to ${next.name || next.id}`))
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
			};
			const showSettings = () => {
				const snapshot = session.snapshot;
				const currentModel = availableModels.find(
					(candidate) => candidate.provider === snapshot?.model.provider && candidate.id === snapshot?.model.id,
				);
				const done = () => {
					restoreTranscript();
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
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector.getSettingsList());
				tui.requestRender();
			};
			const showResume = () => {
				const toSessionInfo = (entry: Awaited<ReturnType<typeof session.listSessions>>[number]): SessionInfo => ({
					path: entry.id,
					id: entry.id,
					cwd: entry.cwd ?? "",
					...(entry.sessionName === undefined ? {} : { name: entry.sessionName }),
					...(entry.parentSessionId === undefined ? {} : { parentSessionPath: entry.parentSessionId }),
					created: new Date(entry.createdAt),
					modified: new Date(entry.updatedAt),
					messageCount: 0,
					firstMessage: entry.sessionName ?? entry.id,
					allMessagesText: entry.sessionName ?? entry.id,
				});
				const loadSessions = async (currentDirectoryOnly: boolean): Promise<SessionInfo[]> =>
					(await session.listSessions())
						.filter((entry) => !currentDirectoryOnly || entry.cwd === process.cwd())
						.map(toSessionInfo);
				const done = () => restoreTranscript();
				const selector = new SessionSelectorComponent(
					() => loadSessions(true),
					() => loadSessions(false),
					(sessionId) => {
						void session
							.attach(sessionId)
							.then(() => {
								view.showStatus("Resumed session");
								done();
							})
							.catch((error: unknown) => {
								view.showStatus(error instanceof Error ? error.message : String(error));
								done();
							});
					},
					done,
					done,
					() => tui.requestRender(),
					{ allowDelete: false, keybindings },
					session.id,
				);
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector);
				tui.requestRender();
			};
			const showFork = () => {
				const messages = (session.snapshot?.transcript ?? [])
					.filter((item) => item.role === "user")
					.map((item) => ({
						id: item.id,
						text: item.content
							.filter((content) => content.type === "text")
							.map((content) => content.text)
							.join("\n"),
					}));
				const done = () => restoreTranscript();
				const selector = new UserMessageSelectorComponent(
					messages,
					(entryId) => {
						void session
							.forkAndAttach({ entryId, position: "before" })
							.then((sessionId) => {
								view.showStatus(`Forked to new session: ${sessionId}`);
								done();
							})
							.catch((error: unknown) => {
								view.showStatus(error instanceof Error ? error.message : String(error));
								done();
							});
					},
					done,
					messages.at(-1)?.id,
				);
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector.getMessageList());
				tui.requestRender();
			};
			const showTree = (initialSelectedId?: string) => {
				void session
					.readTree()
					.then((tree) => {
						const nodes = remoteTreeNodes(tree.entries, tree.labels);
						const entries = new Map(
							tree.entries.flatMap((value) => {
								const entry = remoteTreeEntry(value);
								return entry === undefined ? [] : [[entry.id, entry] as const];
							}),
						);
						if (nodes.length === 0) {
							view.showStatus("No entries in session");
							return;
						}
						const done = () => restoreTranscript();
						const selector = new TreeSelectorComponent(
							nodes,
							tree.leafId,
							tui.terminal.rows,
							(entryId) => {
								if (entryId === tree.leafId) {
									done();
									view.showStatus("Already at this point");
									return;
								}

								const entry = entries.get(entryId);
								if (entry === undefined) {
									done();
									view.showStatus("Selected tree entry is unavailable");
									return;
								}

								done();
								void (async () => {
									let summarize = false;
									let customInstructions: string | undefined;
									if (!statuslineSettings.getBranchSummarySkipPrompt()) {
										while (true) {
											const summaryChoice = await new Promise<string | undefined>((resolve) => {
												const summarySelector = new ExtensionSelectorComponent(
													"Summarize branch?",
													["No summary", "Summarize", "Summarize with custom prompt"],
													(option) => resolve(option),
													() => resolve(undefined),
													{ tui, onToggleToolsExpanded: () => view.toggleToolOutputExpansion() },
												);
												transcriptContainer.clear();
												transcriptContainer.addChild(summarySelector);
												tui.setFocus(summarySelector);
												tui.requestRender();
											});
											if (summaryChoice === undefined) {
												showTree(entryId);
												return;
											}
											summarize = summaryChoice !== "No summary";
											if (summaryChoice === "Summarize with custom prompt") {
												customInstructions = await new Promise<string | undefined>((resolve) => {
													const summaryEditor = new ExtensionEditorComponent(
														tui,
														keybindings,
														"Custom summarization instructions",
														undefined,
														(value) => resolve(value),
														() => resolve(undefined),
														undefined,
														statuslineSettings.getExternalEditorCommand(),
													);
													transcriptContainer.clear();
													transcriptContainer.addChild(summaryEditor);
													tui.setFocus(summaryEditor);
													tui.requestRender();
												});
												if (customInstructions === undefined) continue;
											}
											break;
										}
									}

									const targetId =
										entry.type === "message" && entry.message.role === "user" ? entry.parentId : entry.id;
									const operationId = await session.navigateTree(targetId, { summarize, customInstructions });
									await session.waitForOperation(operationId);
									if (entry.type === "message" && entry.message.role === "user" && !editor.getText().trim()) {
										editor.setText(contentText(entry.message.content, ""));
									}
									view.showStatus("Navigated to selected point");
								})().catch((error: unknown) =>
									view.showStatus(error instanceof Error ? error.message : String(error)),
								);
							},
							done,
							(entryId, label) => {
								void session
									.setTreeLabel(entryId, label)
									.then((operationId) => session.waitForOperation(operationId))
									.then(() =>
										view.showStatus(label === undefined ? "Removed tree label" : "Updated tree label"),
									)
									.catch((error: unknown) =>
										view.showStatus(error instanceof Error ? error.message : String(error)),
									);
							},
							initialSelectedId,
							statuslineSettings.getTreeFilterMode(),
						);
						selector.onCopy = (text) => {
							if (!text) {
								view.showStatus("Selected entry has no text to copy");
								return;
							}
							void copyToClipboard(text)
								.then(() => view.showStatus("Copied selected message to clipboard"))
								.catch((error: unknown) =>
									view.showStatus(error instanceof Error ? error.message : String(error)),
								);
						};
						transcriptContainer.clear();
						transcriptContainer.addChild(selector);
						tui.setFocus(selector);
						tui.requestRender();
					})
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
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
				{
					openSettings: showSettings,
					openModel: showModel,
					openResume: showResume,
					openFork: showFork,
					openTree: showTree,
					openScopedModels: showScopedModels,
					openThinking: showThinking,
					cwd: process.cwd(),
				},
			);
			statusline = new RemoteV2StatuslineComponent(
				session,
				new StatuslineRunner(),
				{ cwd: process.cwd(), transcriptPath: "", projectDir: process.cwd() },
				() => tui?.requestRender(),
			);
			await statusline.setCommand(statuslineSettings.getStatusLineCommand());
			footerContainer.addChild(statusline);
			const interactiveLayout = new InteractiveLayout({
				transcript: transcriptContainer,
				pending: pendingContainer,
				status: statusContainer,
				aboveEditor: aboveEditorContainer,
				editor: editorContainer,
				belowEditor: belowEditorContainer,
				footer: footerContainer,
				scrollbar: statuslineSettings.getFullscreenScrollbar(),
				scrollbarStyle: (text) => text,
			});
			interactiveLayout.mount(tui);
			editor.onAction("app.thinking.cycle", cycleThinking);
			editor.onAction("app.model.cycleForward", () => cycleModel("forward"));
			editor.onAction("app.model.cycleBackward", () => cycleModel("backward"));
			editor.onAction("app.model.select", showModel);
			editor.onAction("app.tools.expand", () => {
				view.showStatus(`Tool output: ${view.toggleToolOutputExpansion() ? "expanded" : "collapsed"}`);
			});
			editor.onAction("app.thinking.toggle", () => {
				const hidden = !statuslineSettings.getHideThinkingBlock();
				statuslineSettings.setHideThinkingBlock(hidden);
				view.refreshPresentation();
				view.showStatus(`Thinking: ${hidden ? "collapsed" : "expanded"}`);
			});
			editor.onAction("app.session.resume", showResume);
			editor.onAction("app.session.fork", showFork);
			editor.onAction("app.session.tree", showTree);
			editor.onAction("app.session.new", () => {
				void attachment
					.execute("/new")
					.then((result) => view.showStatus(result.kind === "status" ? result.text : "New session started"))
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
			});
			tui.setFocus(editor);
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					process.stdin.off("end", finish);
					tui.stop();
					void attachment.dispose().finally(() => {
						footer.dispose();
						footerData.dispose();
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
