#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { dirname, join } from "node:path";
import { type AgentMessage, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/pi-protocol";
import { Container, Spacer, setKeybindings } from "@earendil-works/pi-tui";
import { isServerDefaultCompatible, parseArgs } from "./cli/args.ts";
import { dispatchExperimentalCommand, isExperimentalCommand } from "./cli/experimental/dispatch.ts";
import { RemoteV2InteractiveAttachment } from "./client/remote-v2-interactive.ts";
import { RemoteV2FooterComponent, RemoteV2SessionView, RemoteV2StatuslineComponent } from "./client/remote-v2-view.ts";
import { APP_NAME, getAgentDir, getDebugLogPath, getShareViewerUrl, VERSION } from "./config.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./core/defaults.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import { FooterDataProvider } from "./core/footer-data-provider.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import { resolveModelScopeFromModels, selectScopedDefaultModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import type { SessionEntry, SessionInfo, SessionTreeNode } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { main } from "./main.ts";
import {
	createChangelogCommandOutput,
	createHotkeysCommandOutput,
	createSessionCommandOutput,
} from "./modes/interactive/command-output.ts";
import { BashExecutionComponent } from "./modes/interactive/components/bash-execution.ts";
import { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
import { ExtensionEditorComponent } from "./modes/interactive/components/extension-editor.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { InteractiveLayout } from "./modes/interactive/components/interactive-layout.ts";
import { formatInteractiveTerminalTitle } from "./modes/interactive/components/interactive-title.ts";
import { LoginDialogComponent } from "./modes/interactive/components/login-dialog.ts";
import { ModelSelectorComponent } from "./modes/interactive/components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "./modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./modes/interactive/components/session-selector.ts";
import { SettingsSelectorComponent } from "./modes/interactive/components/settings-selector.ts";
import { createInteractiveStartupHeader } from "./modes/interactive/components/startup-header.ts";
import { ThinkingSelectorComponent } from "./modes/interactive/components/thinking-selector.ts";
import { TreeSelectorComponent } from "./modes/interactive/components/tree-selector.ts";
import { TrustSelectorComponent } from "./modes/interactive/components/trust-selector.ts";
import { UserMessageSelectorComponent } from "./modes/interactive/components/user-message-selector.ts";
import { editInExternalEditor } from "./modes/interactive/external-editor.ts";
import { createInteractiveTui } from "./modes/interactive/interactive-mode.ts";
import {
	getAvailableThemes,
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	stopThemeWatcher,
} from "./modes/interactive/theme/theme.ts";
import {
	type ConfiguredCodingAgentDaemonRuntimeOptions,
	createCodingAgentClientRuntime,
	createConfiguredCodingAgentDaemonRuntime,
} from "./server/daemon-runtime.ts";
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
			typeof pid !== "number" ||
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
	const runningServer = detachedServerStatus(agentDir);
	const statuslineSettings = SettingsManager.create(process.cwd(), agentDir);
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
	const availableModels = await modelRuntime.getAvailable();
	let scopedModels = resolveModelScopeFromModels(
		statuslineSettings.getEnabledModels() ?? [],
		availableModels,
	).scopedModels;
	const defaultProvider = statuslineSettings.getDefaultProvider();
	const defaultModelId = statuslineSettings.getDefaultModel();
	const model =
		selectScopedDefaultModel(
			scopedModels,
			defaultProvider === undefined || defaultModelId === undefined
				? undefined
				: { provider: defaultProvider, id: defaultModelId },
		)?.model ?? availableModels[0];
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
	const runtimeOptions: ConfiguredCodingAgentDaemonRuntimeOptions = {
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
			setKeybindings(keybindings);
			initTheme(statuslineSettings.getTheme(), true);
			const tui = createInteractiveTui({
				tuiMode: options.tuiMode ?? statuslineSettings.getTuiMode(),
				showHardwareCursor: statuslineSettings.getShowHardwareCursor(),
				logDirectory: agentDir,
			});
			tui.setClearOnShrink(statuslineSettings.getClearOnShrink());
			const editor = new CustomEditor(tui, getEditorTheme(), keybindings, {
				paddingX: statuslineSettings.getEditorPaddingX(),
				autocompleteMaxVisible: statuslineSettings.getAutocompleteMaxVisible(),
			});
			const pendingContainer = new Container();
			const updateTerminalTitle = () => {
				tui.terminal.setTitle(formatInteractiveTerminalTitle(process.cwd(), session.snapshot?.name));
			};
			const view = new RemoteV2SessionView(session, {
				tui,
				cwd: process.cwd(),
				pendingContainer,
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
			const documentContainer = new Container();
			const startupHeader = statuslineSettings.getQuietStartup()
				? undefined
				: createInteractiveStartupHeader({ version: VERSION, expanded: false });
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
			const renderDocument = () => {
				documentContainer.clear();
				if (startupHeader !== undefined) {
					documentContainer.addChild(new Spacer(1));
					documentContainer.addChild(startupHeader);
					documentContainer.addChild(new Spacer(1));
				}
				documentContainer.addChild(view);
			};
			const restoreTranscript = () => {
				transcriptContainer.clear();
				renderDocument();
				transcriptContainer.addChild(documentContainer);
				tui.setFocus(editor);
				tui.requestRender();
			};
			restoreTranscript();
			let statusline: RemoteV2StatuslineComponent;
			let attachment: RemoteV2InteractiveAttachment;
			let finishInteractive: () => void = () => {};
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
			const showLogin = (providerId: string, type: "oauth" | "api_key") => {
				const providerName = modelRuntime.getProvider(providerId)?.name ?? providerId;
				let loginId: string | undefined;
				let restored = false;
				const unsubscribe = session.subscribe(() => {
					const interaction = session.getAuthInteraction();
					if (interaction === undefined || interaction.loginId !== loginId || restored) return;
					if (interaction.kind === "completed") {
						restore();
						view.showStatus(
							interaction.success
								? `Logged in to ${providerName}`
								: `Login failed: ${interaction.message ?? "unknown error"}`,
						);
						return;
					}
					if (interaction.kind === "notify") {
						const event = interaction.event;
						if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
						else if (event.type === "device_code") {
							dialog.showDeviceCode(event);
							dialog.showWaiting("Waiting for authentication...");
						} else if (event.type === "info") dialog.showInfo(event.message, event.links);
						else dialog.showProgress(event.message);
						return;
					}
					if (interaction.prompt.type === "select") {
						const options = interaction.prompt.options;
						const selector = new ExtensionSelectorComponent(
							interaction.prompt.message,
							options.map((option) => option.label),
							(label) => {
								showDialog();
								const option = options.find((candidate) => candidate.label === label);
								if (option) void session.respondLogin(interaction.loginId, option.id);
							},
							() => {
								if (loginId !== undefined) void session.cancelLogin(loginId).catch(() => undefined);
								restore();
							},
						);
						transcriptContainer.clear();
						transcriptContainer.addChild(selector);
						tui.setFocus(selector);
						tui.requestRender();
						return;
					}
					const prompt =
						interaction.prompt.type === "manual_code"
							? dialog.showManualInput(interaction.prompt.message)
							: dialog.showPrompt(interaction.prompt.message, interaction.prompt.placeholder);
					void prompt.then((value) => session.respondLogin(interaction.loginId, value)).catch(() => undefined);
				});
				const restore = () => {
					if (restored) return;
					restored = true;
					unsubscribe();
					restoreTranscript();
				};
				const dialog = new LoginDialogComponent(
					tui,
					providerId,
					() => {
						if (loginId !== undefined) void session.cancelLogin(loginId).catch(() => undefined);
						restore();
					},
					providerName,
				);
				const showDialog = () => {
					transcriptContainer.clear();
					transcriptContainer.addChild(dialog);
					tui.setFocus(dialog);
					tui.requestRender();
				};
				showDialog();
				void session.startLogin(providerId, type).then(
					(id) => {
						loginId = id;
					},
					(error: unknown) => {
						restore();
						view.showStatus(error instanceof Error ? error.message : String(error));
					},
				);
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
					{ allModels: [...availableModels], enabledModelIds: enabledIds },
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
						currentTheme: statuslineSettings.getTheme() ?? "dark",
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
			const showTrust = () => {
				const cwd = process.cwd();
				const trustStore = new ProjectTrustStore(agentDir);
				const projectTrusted = !hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
				const done = () => restoreTranscript();
				const selector = new TrustSelectorComponent({
					cwd,
					savedDecision: trustStore.getEntry(cwd),
					projectTrusted,
					onSelect: (selection) => {
						trustStore.setMany(selection.updates);
						done();
						view.showStatus(
							`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
						);
					},
					onCancel: done,
				});
				transcriptContainer.clear();
				transcriptContainer.addChild(selector);
				tui.setFocus(selector);
				tui.requestRender();
			};
			const exportSession = async (outputPath?: string): Promise<string> => {
				const jsonl = await session.exportJsonl();
				if (outputPath?.endsWith(".jsonl")) {
					await writeFile(outputPath, jsonl, "utf8");
					return outputPath;
				}
				const temporaryDirectory = await mkdtemp(join(agentDir, "export-"));
				const temporaryJsonlPath = join(temporaryDirectory, `${session.id}.jsonl`);
				try {
					await writeFile(temporaryJsonlPath, jsonl, "utf8");
					return await exportFromFile(temporaryJsonlPath, {
						...(outputPath === undefined ? {} : { outputPath }),
						themeName: statuslineSettings.getTheme(),
					});
				} finally {
					await rm(temporaryDirectory, { recursive: true, force: true });
				}
			};
			const importSession = async (inputPath: string): Promise<string> => {
				await session.importAndAttach({ jsonl: await readFile(inputPath, "utf8"), cwd: process.cwd() });
				return inputPath;
			};
			const runGitHubCli = async (
				args: string[],
			): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null }> =>
				new Promise((resolve, reject) => {
					const process = spawn("gh", args);
					let stdout = "";
					let stderr = "";
					process.stdout?.on("data", (data: Buffer) => {
						stdout += data.toString();
					});
					process.stderr?.on("data", (data: Buffer) => {
						stderr += data.toString();
					});
					process.once("error", reject);
					process.once("close", (code) => resolve({ stdout, stderr, code }));
				});
			const shareSession = async (): Promise<string> => {
				const temporaryDirectory = await mkdtemp(join(agentDir, "share-"));
				try {
					const htmlPath = join(temporaryDirectory, "session.html");
					const jsonlPath = join(temporaryDirectory, `${session.id}.jsonl`);
					await writeFile(jsonlPath, await session.exportJsonl(), "utf8");
					await exportFromFile(jsonlPath, { outputPath: htmlPath, themeName: statuslineSettings.getTheme() });
					const auth = await runGitHubCli(["auth", "status"]);
					if (auth.code !== 0) throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
					const gist = await runGitHubCli(["gist", "create", "--public=false", htmlPath]);
					if (gist.code !== 0) throw new Error(gist.stderr.trim() || "Failed to create GitHub gist");
					const gistUrl = gist.stdout.trim();
					const gistId = gistUrl.split("/").pop();
					if (!gistId) throw new Error("Failed to parse gist ID from gh output");
					return `Share URL: ${getShareViewerUrl(gistId)}\nGist: ${gistUrl}`;
				} finally {
					await rm(temporaryDirectory, { recursive: true, force: true });
				}
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
					showDebug: async () => {
						const width = tui.terminal.columns;
						const debugLogPath = getDebugLogPath();
						const content = [
							`Debug output at ${new Date().toISOString()}`,
							`Terminal width: ${width}`,
							"",
							"=== Rendered lines ===",
							...tui.render(width).map((line, index) => `[${index}] ${JSON.stringify(line)}`),
							"",
							"=== Server snapshot ===",
							JSON.stringify(session.snapshot),
							"",
						].join("\n");
						await mkdir(dirname(debugLogPath), { recursive: true });
						await writeFile(debugLogPath, content);
						return debugLogPath;
					},
					showChangelog: () =>
						view.addTransientTranscriptComponent(createChangelogCommandOutput(getMarkdownTheme())),
					showHotkeys: () =>
						view.addTransientTranscriptComponent(createHotkeysCommandOutput(keybindings, getMarkdownTheme())),
					showSession: () =>
						view.addTransientTranscriptComponent(
							createSessionCommandOutput(session.snapshot, getMarkdownTheme()),
						),
					openSettings: showSettings,
					openModel: showModel,
					openLogin: showLogin,
					openResume: showResume,
					openFork: showFork,
					openTree: showTree,
					openScopedModels: showScopedModels,
					openThinking: showThinking,
					openTrust: showTrust,
					exportSession,
					importSession,
					shareSession,
					quit: () => finishInteractive(),
					executeShell: async (command, excludeFromContext) => {
						const component = new BashExecutionComponent(command, tui, excludeFromContext);
						view.addTransientTranscriptComponent(component);
						const shellProcess = await session.startProcess(command, { cwd: process.cwd(), pty: false });
						let cursor = 0;
						let reads = Promise.resolve();
						const consumeOutput = () => {
							reads = reads.then(async () => {
								const output = await session.readProcess(shellProcess.processId, cursor);
								if (output.output.length > 0) component.appendOutput(output.output);
								cursor = output.cursor;
								tui.requestRender();
							});
							return reads;
						};
						const unsubscribe = session.subscribe((state) => {
							const updated = state.processes?.find(
								(candidate) => candidate.processId === shellProcess.processId,
							);
							if (updated !== undefined && updated.cursor > cursor) void consumeOutput();
						});
						try {
							await consumeOutput();
							const completed = await session.waitProcess(shellProcess.processId);
							await consumeOutput();
							const cancelled = completed.state === "terminated" || completed.state === "lost";
							component.setComplete(completed.exitCode, cancelled);
							await session.recordBash({
								command,
								output: component.getOutput(),
								...(completed.exitCode === undefined ? {} : { exitCode: completed.exitCode }),
								cancelled,
								truncated: completed.truncated,
								excludeFromContext,
							});
							tui.requestRender();
						} finally {
							unsubscribe();
						}
					},
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
				const expanded = view.toggleToolOutputExpansion();
				startupHeader?.setExpanded(expanded);
				view.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
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
			editor.onAction("app.message.copy", () => {
				void attachment
					.execute("/copy")
					.then((result) => view.showStatus(result.kind === "status" ? result.text : "Copied last agent message"))
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
			});
			editor.onAction("app.message.followUp", () => {
				const text = editor.getText().trim();
				if (!text) return;
				if (session.phase !== "turn") {
					editor.setText("");
					editor.onSubmit?.(text);
					return;
				}
				editor.setText("");
				void session
					.followUp(text)
					.then((operationId) => view.showStatus(`Follow-up accepted: ${operationId}`))
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
			});
			editor.onAction("app.message.dequeue", () => {
				void attachment
					.dequeueAll()
					.then((count) =>
						view.showStatus(count === 0 ? "No queued messages to restore" : `Restored ${count} queued messages`),
					)
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)));
			});
			editor.onAction("app.editor.external", () => {
				const content = editor.getExpandedText?.() ?? editor.getText();
				tui.stop();
				void editInExternalEditor({ command: statuslineSettings.getExternalEditorCommand(), content })
					.then((result) => {
						if (result.status === "complete") editor.setText(result.content);
					})
					.catch((error: unknown) => view.showStatus(error instanceof Error ? error.message : String(error)))
					.finally(() => {
						tui.start();
						tui.requestRender(true);
					});
			});
			editor.onAction("app.suspend", () => {
				if (process.platform === "win32") {
					view.showStatus("Suspend to background is not supported on Windows");
					return;
				}
				const keepAlive = setInterval(() => {}, 2 ** 30);
				const ignoreSigint = () => {};
				process.on("SIGINT", ignoreSigint);
				process.once("SIGCONT", () => {
					clearInterval(keepAlive);
					process.removeListener("SIGINT", ignoreSigint);
					tui.start();
					tui.requestRender(true);
				});
				try {
					tui.stop();
					process.kill(0, "SIGTSTP");
				} catch (error) {
					clearInterval(keepAlive);
					process.removeListener("SIGINT", ignoreSigint);
					view.showStatus(error instanceof Error ? error.message : String(error));
				}
			});
			tui.setFocus(editor);
			await new Promise<void>((resolve) => {
				let settled = false;
				let removeClearListener: (() => void) | undefined;
				const finish = () => {
					if (settled) return;
					settled = true;
					process.stdin.off("end", finish);
					removeClearListener?.();
					tui.stop();
					void attachment.dispose().finally(() => {
						footer.dispose();
						footerData.dispose();
						statusline.dispose();
						stopThemeWatcher();
						resolve();
					});
				};
				finishInteractive = finish;
				removeClearListener = tui.addInputListener((data) => {
					if (!keybindings.matches(data, "app.clear")) return undefined;
					if (editor.getText().length === 0) finish();
					else {
						editor.setText("");
						tui.setFocus(editor);
					}
					return { consume: true };
				});
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
	};
	const attachedClientMode =
		runningServer !== undefined && (serverDefaultInteractive || serverDefaultPrint || serverDefaultRpc);
	const runtime = !attachedClientMode
		? await createConfiguredCodingAgentDaemonRuntime(runtimeOptions)
		: createCodingAgentClientRuntime({
				...runtimeOptions,
				daemon: {
					start: async (socket) => {
						if (socket !== undefined && socket !== runtimeOptions.socketPath)
							throw new Error(`Daemon is configured for socket ${runtimeOptions.socketPath}`);
						return runningServer;
					},
					status: () => runningServer,
					stop: async () => runningServer,
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
