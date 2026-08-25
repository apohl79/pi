import type { PlanItem, SessionSnapshotV2, ThinkingLevel } from "@earendil-works/pi-protocol";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Editor,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import { copyToClipboard, readClipboardText } from "../utils/clipboard.ts";
import { type ClipboardImage, readClipboardImage } from "../utils/clipboard-image.ts";
import type { RemoteV2SessionAttachment } from "./remote-v2-selector.ts";
import type { RemoteV2FileCompletion, RemoteV2PromptContent } from "./remote-v2-session.ts";

export const REMOTE_V2_SLASH_COMMANDS = [
	"/model",
	"/login",
	"/logout",
	"/abort",
	"/agent-follow-up",
	"/agent-interrupt",
	"/agent-message",
	"/compact",
	"/clone",
	"/copy",
	"/debug",
	"/changelog",
	"/dequeue",
	"/detach",
	"/export",
	"/follow-up",
	"/fork",
	"/goal",
	"/goal-pause",
	"/goal-resume",
	"/input",
	"/input-cancel",
	"/hotkeys",
	"/import",
	"/interrupt-child",
	"/name",
	"/name-auto",
	"/new",
	"/plan",
	"/plan-clear",
	"/plugins",
	"/quit",
	"/release-control",
	"/reload",
	"/resume",
	"/rollback",
	"/settings",
	"/session",
	"/scoped-models",
	"/share",
	"/statusline",
	"/steer",
	"/take-control",
	"/thinking",
	"/tree",
	"/trust",
] as const;

const REMOTE_V2_COMMAND_DESCRIPTIONS: Readonly<Partial<Record<(typeof REMOTE_V2_SLASH_COMMANDS)[number], string>>> = {
	"/abort": "Abort the active server operation",
	"/agent-follow-up": "Send a follow-up to a child agent",
	"/agent-interrupt": "Interrupt a child agent",
	"/agent-message": "Send a message to a child agent",
	"/dequeue": "Recall a queued message into the editor",
	"/detach": "Detach this TUI and leave the server session running",
	"/follow-up": "Queue a follow-up after the active operation",
	"/goal": "Create a durable session goal",
	"/goal-pause": "Pause the active durable goal",
	"/goal-resume": "Resume the paused durable goal",
	"/input": "Answer a server input request",
	"/input-cancel": "Cancel a server input request",
	"/interrupt-child": "Interrupt a child agent",
	"/name-auto": "Enable or disable automatic session names",
	"/logout": "Remove a server-stored provider credential",
	"/login": "Authenticate a provider through the server",
	"/plan": "Replace the server session plan",
	"/plan-clear": "Clear the server session plan",
	"/plugins": "List server session plugins",
	"/release-control": "Release control of this server session",
	"/rollback": "Rollback recent server conversation turns",
	"/steer": "Steer the active server operation",
	"/take-control": "Acquire control of this server session",
};

function remoteV2CommandDescription(command: (typeof REMOTE_V2_SLASH_COMMANDS)[number]): string {
	const builtin = BUILTIN_SLASH_COMMANDS.find((candidate) => `/${candidate.name}` === command);
	return builtin?.description ?? REMOTE_V2_COMMAND_DESCRIPTIONS[command] ?? "Server session command";
}

export type RemoteV2Command =
	| { readonly name: "abort" }
	| { readonly name: "agent-follow-up"; readonly agentId: string; readonly text: string }
	| { readonly name: "agent-interrupt"; readonly agentId: string }
	| { readonly name: "interrupt-child"; readonly agentId: string }
	| { readonly name: "agent-message"; readonly agentId: string; readonly text: string }
	| { readonly name: "compact"; readonly instructions?: string }
	| { readonly name: "clone" }
	| { readonly name: "copy" }
	| { readonly name: "debug" }
	| { readonly name: "changelog" }
	| { readonly name: "dequeue"; readonly entryId: string }
	| { readonly name: "detach" }
	| { readonly name: "export"; readonly outputPath?: string }
	| { readonly name: "follow-up"; readonly text: string }
	| { readonly name: "fork" }
	| { readonly name: "goal"; readonly objective: string }
	| { readonly name: "goal-pause" }
	| { readonly name: "goal-resume" }
	| { readonly name: "input"; readonly requestId: string; readonly answers: Readonly<Record<string, string>> }
	| { readonly name: "input-cancel"; readonly requestId: string }
	| { readonly name: "login"; readonly providerId?: string; readonly type?: "oauth" | "api_key" }
	| { readonly name: "import"; readonly inputPath: string }
	| { readonly name: "hotkeys" }
	| { readonly name: "model" }
	| { readonly name: "model"; readonly provider: string; readonly id: string }
	| { readonly name: "logout"; readonly providerId?: string }
	| { readonly name: "name"; readonly value?: string; readonly clear?: boolean; readonly generate?: boolean }
	| { readonly name: "name-auto"; readonly enabled: boolean }
	| { readonly name: "new" }
	| { readonly name: "plan"; readonly items: readonly PlanItem[] }
	| { readonly name: "plan-clear" }
	| { readonly name: "plugins" }
	| { readonly name: "quit" }
	| { readonly name: "release-control" }
	| { readonly name: "reload" }
	| { readonly name: "resume" }
	| { readonly name: "rollback"; readonly turns: number }
	| { readonly name: "settings" }
	| { readonly name: "session" }
	| { readonly name: "scoped-models" }
	| { readonly name: "share" }
	| { readonly name: "statusline"; readonly command?: string }
	| { readonly name: "steer"; readonly text: string }
	| { readonly name: "take-control" }
	| { readonly name: "thinking" }
	| { readonly name: "thinking"; readonly level: ThinkingLevel }
	| { readonly name: "tree" }
	| { readonly name: "trust" };

export type RemoteV2CommandResult =
	| { readonly kind: "operation"; readonly operationId: string }
	| { readonly kind: "control"; readonly mode: "control" | "observer" }
	| { readonly kind: "status"; readonly text: string }
	| { readonly kind: "detached" };

type RemoteFileAutocompleteItem = AutocompleteItem & Pick<RemoteV2FileCompletion, "kind" | "reference">;

type RemoteInteractiveEditor = Editor & {
	onEscape?: () => void;
	onPasteImage?: () => void;
	insertTextAtCursor?: (text: string) => void;
};

/** Async editor completions backed by the authoritative remote filesystem service. */
export class RemoteV2AutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters = ["/", "@"];
	readonly #session: RemoteV2SessionAttachment["session"];
	#requestSequence = 0;

	constructor(session: RemoteV2SessionAttachment["session"]) {
		this.#session = session;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const input = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const model = await this.modelSuggestions(input, options.signal);
		if (model !== null) return model;
		const thinking = await this.thinkingSuggestions(input, options.signal);
		if (thinking !== null) return thinking;
		const command = await this.commandSuggestions(input, options.signal);
		if (command !== null) return command;

		const tokenStart = Math.max(input.lastIndexOf(" "), input.lastIndexOf("\t")) + 1;
		const prefix = input.slice(tokenStart);
		if (!prefix.startsWith("@")) return null;
		const requestId = `autocomplete-${++this.#requestSequence}`;
		const completions = await this.#session.completeFiles(prefix, { requestId });
		if (options.signal.aborted) return null;
		const items: RemoteFileAutocompleteItem[] = completions.map((completion) => ({
			value: completion.reference,
			label: completion.reference,
			description: completion.kind,
			kind: completion.kind,
			reference: completion.reference,
		}));
		return items.length === 0 ? null : { items, prefix };
	}

	private async thinkingSuggestions(input: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
		const match = /^\/thinking\s+([^\s]*)$/u.exec(input);
		if (!match) return null;
		const selectedModel = this.#session.snapshot?.model;
		if (selectedModel === undefined) return null;
		const models = await this.#session.listModels();
		if (signal.aborted) return null;
		const model = models.find(
			(candidate) => candidate.provider === selectedModel.provider && candidate.id === selectedModel.id,
		);
		if (model === undefined) return null;
		const prefix = match[1] ?? "";
		const items = fuzzyFilter(
			model.supportedThinkingLevels.map((level) => ({ value: level, label: level })),
			prefix,
			(item) => item.value,
		);
		return items.length === 0 ? null : { items, prefix };
	}

	private async modelSuggestions(input: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
		const match = /^\/model\s+([^\s]*)$/u.exec(input);
		if (!match) return null;
		const prefix = match[1] ?? "";
		const models = await this.#session.listModels();
		if (signal.aborted) return null;
		const items = fuzzyFilter(
			models.map((model) => ({
				value: `${model.provider}/${model.id}`,
				label: model.id,
				description: model.provider,
			})),
			prefix,
			(item) => `${item.value} ${item.label} ${item.description}`,
		);
		return items.length === 0 ? null : { items, prefix };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const input = lines[cursorLine] ?? "";
		const beforeCursor = input.slice(0, cursorCol);
		const afterCursor = input.slice(cursorCol);
		const beforePrefix = beforeCursor.slice(0, Math.max(0, beforeCursor.length - prefix.length));
		const remoteFile = item as RemoteFileAutocompleteItem;
		const completed =
			remoteFile.kind === "file" || remoteFile.kind === "directory"
				? applyRemoteFileCompletion(beforeCursor, beforePrefix.length, remoteFile)
				: `${beforePrefix}${beforePrefix.length === 0 ? "/" : ""}${item.value} `;
		const nextLine = `${completed}${afterCursor}`;
		const nextLines = [...lines];
		nextLines[cursorLine] = nextLine;
		return { lines: nextLines, cursorLine, cursorCol: completed.length };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const input = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const tokenStart = Math.max(input.lastIndexOf(" "), input.lastIndexOf("\t")) + 1;
		return input.slice(tokenStart).startsWith("@");
	}

	async commandSuggestions(input: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
		if (!input.startsWith("/") || /\s/u.test(input)) return null;
		const prefix = input.slice(1);
		const resources = await this.#session.listInteractiveResources();
		if (signal.aborted) return null;
		const items = fuzzyFilter(
			[
				...REMOTE_V2_SLASH_COMMANDS.map((command) => ({
					value: command.slice(1),
					label: command.slice(1),
					description: remoteV2CommandDescription(command),
				})),
				...resources.map((resource) => ({
					value: resource.name,
					label: resource.name,
					description: resource.description ?? (resource.kind === "skill" ? "Server skill" : "Server prompt"),
				})),
			],
			prefix,
			(item) => `${item.value} ${item.description ?? ""}`,
		);
		return items.length === 0 ? null : { items, prefix: input };
	}
}

/** Applies a server completion while keeping directory navigation composable across Tab presses. */
export function applyRemoteFileCompletion(
	input: string,
	tokenStart: number,
	item: Pick<RemoteV2FileCompletion, "reference" | "kind">,
): string {
	const typedToken = input.slice(tokenStart);
	const marker = typedToken.startsWith("@") && !item.reference.startsWith("@") ? "@" : "";
	const markedToken = typedToken.slice(marker.length);
	const scope = /^(?:server|local|project):/u.exec(markedToken)?.[0] ?? "";
	const quote =
		markedToken.slice(scope.length).startsWith('"') || markedToken.slice(scope.length).startsWith("'")
			? markedToken.slice(scope.length, scope.length + 1)
			: "";
	const completionReference =
		scope !== "" && item.reference.startsWith(scope) ? item.reference.slice(scope.length) : item.reference;
	const reference = `${marker}${scope}${quote}${completionReference}`;
	if (item.kind === "file") return `${input.slice(0, tokenStart)}${reference}${quote}`;
	const separator = item.reference.includes("\\") && !item.reference.includes("/") ? "\\" : "/";
	const descended = reference.endsWith("/") || reference.endsWith("\\") ? reference : `${reference}${separator}`;
	return `${input.slice(0, tokenStart)}${descended}`;
}

export function parseRemoteV2Command(input: string): RemoteV2Command {
	const parts = input.trim().split(/\s+/u);
	const [name, ...arguments_] = parts;
	if (
		name === "/abort" ||
		name === "/clone" ||
		name === "/copy" ||
		name === "/debug" ||
		name === "/changelog" ||
		name === "/detach" ||
		name === "/fork" ||
		name === "/hotkeys" ||
		name === "/quit" ||
		name === "/release-control" ||
		name === "/reload" ||
		name === "/resume" ||
		name === "/session" ||
		name === "/scoped-models" ||
		name === "/share" ||
		name === "/take-control" ||
		name === "/tree" ||
		name === "/trust"
	) {
		if (arguments_.length > 0) throw new Error(`${name} does not accept arguments`);
		return { name: name.slice(1) as RemoteV2Command["name"] } as RemoteV2Command;
	}
	if (name === "/export") {
		const outputPath = getRemoteV2PathCommandArgument(input, "/export");
		return outputPath === undefined ? { name: "export" } : { name: "export", outputPath };
	}
	if (name === "/import") {
		const inputPath = getRemoteV2PathCommandArgument(input, "/import");
		if (inputPath === undefined) throw new Error("/import requires <path.jsonl>");
		return { name: "import", inputPath };
	}
	if (name === "/follow-up") {
		const text = arguments_.join(" ").trim();
		if (!text) throw new Error("/follow-up requires text");
		return { name: "follow-up", text };
	}
	if (name === "/agent-follow-up") {
		const text = arguments_.slice(1).join(" ").trim();
		if (arguments_.length < 2 || !text) throw new Error("/agent-follow-up requires <agent-id> <text>");
		return { name: "agent-follow-up", agentId: arguments_[0], text };
	}
	if (name === "/agent-interrupt" || name === "/interrupt-child") {
		if (arguments_.length !== 1) throw new Error("/agent-interrupt requires <agent-id>");
		return { name: name === "/interrupt-child" ? "interrupt-child" : "agent-interrupt", agentId: arguments_[0] };
	}
	if (name === "/agent-message") {
		const text = arguments_.slice(1).join(" ").trim();
		if (arguments_.length < 2 || !text) throw new Error("/agent-message requires <agent-id> <text>");
		return { name: "agent-message", agentId: arguments_[0], text };
	}
	if (name === "/compact") {
		const instructions = arguments_.join(" ").trim();
		return instructions.length === 0 ? { name: "compact" } : { name: "compact", instructions };
	}
	if (name === "/dequeue") {
		if (arguments_.length !== 1 || !arguments_[0]) throw new Error("/dequeue requires <entry-id>");
		return { name: "dequeue", entryId: arguments_[0] };
	}
	if (name === "/goal") {
		const objective = arguments_.join(" ").trim();
		if (!objective) throw new Error("/goal requires objective");
		return { name: "goal", objective };
	}
	if (name === "/goal-pause" || name === "/goal-resume") {
		if (arguments_.length > 0) throw new Error(`${name} does not accept arguments`);
		return { name: name.slice(1) as "goal-pause" | "goal-resume" };
	}
	if (name === "/input") {
		if (arguments_.length < 2) throw new Error("/input requires <request-id> <answers-json>");
		let parsed: unknown;
		try {
			parsed = JSON.parse(arguments_.slice(1).join(" "));
		} catch {
			throw new Error("/input answers must be valid JSON");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("/input answers must be a JSON object");
		const answers = Object.fromEntries(
			Object.entries(parsed).map(([key, value]) => {
				if (typeof value !== "string") throw new Error("/input answers must contain only strings");
				return [key, value];
			}),
		);
		return { name: "input", requestId: arguments_[0], answers };
	}
	if (name === "/input-cancel") {
		if (arguments_.length !== 1) throw new Error("/input-cancel requires <request-id>");
		return { name: "input-cancel", requestId: arguments_[0] };
	}
	if (name === "/login") {
		if (arguments_.length === 0) return { name: "login" };
		if (arguments_.length === 1) return { name: "login", providerId: arguments_[0] };
		if (arguments_.length === 2 && (arguments_[1] === "oauth" || arguments_[1] === "api_key"))
			return { name: "login", providerId: arguments_[0]!, type: arguments_[1] };
		throw new Error("/login accepts [provider] [oauth|api_key]");
	}
	if (name === "/model") {
		if (arguments_.length === 0) return { name: "model" };
		if (arguments_.length !== 1) throw new Error("/model requires <provider/model>");
		const separator = arguments_[0].indexOf("/");
		if (separator < 1 || separator === arguments_[0].length - 1) throw new Error("/model requires <provider/model>");
		return { name: "model", provider: arguments_[0].slice(0, separator), id: arguments_[0].slice(separator + 1) };
	}
	if (name === "/logout") {
		if (arguments_.length > 1) throw new Error("/logout accepts at most one provider");
		return arguments_[0] === undefined ? { name: "logout" } : { name: "logout", providerId: arguments_[0] };
	}
	if (name === "/name") {
		if (arguments_.length === 0) return { name: "name" };
		if (arguments_[0] === "--auto") {
			if (arguments_.length !== 2 || (arguments_[1] !== "on" && arguments_[1] !== "off"))
				throw new Error("/name --auto requires on or off");
			return { name: "name-auto", enabled: arguments_[1] === "on" };
		}
		if (arguments_.length === 1 && arguments_[0] === "--clear") return { name: "name", clear: true };
		if (arguments_.length === 1 && arguments_[0] === "--generate") return { name: "name", generate: true };
		if (arguments_[0].startsWith("--")) throw new Error("/name accepts a title, --clear, or --generate");
		return { name: "name", value: arguments_.join(" ").trim() };
	}
	if (name === "/name-auto") {
		if (arguments_.length !== 1 || (arguments_[0] !== "on" && arguments_[0] !== "off"))
			throw new Error("/name-auto requires on or off");
		return { name: "name-auto", enabled: arguments_[0] === "on" };
	}
	if (name === "/new") {
		if (arguments_.length > 0) throw new Error("/new does not accept arguments");
		return { name: "new" };
	}
	if (name === "/plan") {
		if (arguments_.length === 0) throw new Error("/plan requires an items JSON array");
		let parsed: unknown;
		try {
			parsed = JSON.parse(arguments_.join(" "));
		} catch {
			throw new Error("/plan items must be valid JSON");
		}
		if (!Array.isArray(parsed)) throw new Error("/plan items must be a JSON array");
		const items: PlanItem[] = parsed.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item))
				throw new Error("/plan items must be objects");
			const candidate = item as { step?: unknown; status?: unknown };
			if (
				typeof candidate.step !== "string" ||
				!(["pending", "in_progress", "completed"] as const).includes(candidate.status as never)
			)
				throw new Error("/plan items require step and valid status");
			return { step: candidate.step, status: candidate.status } as PlanItem;
		});
		return { name: "plan", items };
	}
	if (name === "/plan-clear") {
		if (arguments_.length > 0) throw new Error("/plan-clear does not accept arguments");
		return { name: "plan-clear" };
	}
	if (name === "/plugins") {
		if (arguments_.length > 0) throw new Error("/plugins does not accept arguments");
		return { name: "plugins" };
	}
	if (name === "/settings") {
		if (arguments_.length > 0) throw new Error("/settings does not accept arguments");
		return { name: "settings" };
	}
	if (name === "/rollback") {
		const turns = arguments_.length === 0 ? 1 : Number(arguments_[0]);
		if (arguments_.length > 1 || !Number.isInteger(turns) || turns < 1) {
			throw new Error("/rollback requires a positive integer turn count");
		}
		return { name: "rollback", turns };
	}
	if (name === "/statusline") {
		if (arguments_.length === 0) throw new Error("/statusline requires a command or off");
		const command = arguments_.join(" ").trim();
		return { name: "statusline", ...(command === "off" ? {} : { command }) };
	}
	if (name === "/steer") {
		const text = arguments_.join(" ").trim();
		if (!text) throw new Error("/steer requires text");
		return { name: "steer", text };
	}
	if (name === "/thinking") {
		if (arguments_.length === 0) return { name: "thinking" };
		if (arguments_.length !== 1 || !isThinkingLevel(arguments_[0]))
			throw new Error("/thinking requires a valid level");
		return { name: "thinking", level: arguments_[0] };
	}
	throw new Error(`Unknown remote session command: ${name || "<empty>"}`);
}

function getRemoteV2PathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
	if (text === command || !text.startsWith(`${command} `)) return undefined;
	const argsString = text.slice(command.length + 1).trimStart();
	if (!argsString) return undefined;
	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		return closingQuoteIndex < 0 ? undefined : argsString.slice(1, closingQuoteIndex);
	}
	const firstWhitespaceIndex = argsString.search(/\s/u);
	return firstWhitespaceIndex < 0 ? argsString : argsString.slice(0, firstWhitespaceIndex);
}

export function getLastRemoteAssistantText(snapshot: SessionSnapshotV2 | undefined): string | undefined {
	const message = snapshot?.transcript
		.slice()
		.reverse()
		.find((candidate) => candidate.role === "assistant");
	if (message === undefined) return undefined;
	const text = message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("")
		.trim();
	return text || undefined;
}

/** Binds server-backed commands and completions to the shared interactive editor. */
export class RemoteV2InteractiveAttachment {
	readonly #attachment: RemoteV2SessionAttachment;
	readonly #editor: RemoteInteractiveEditor | undefined;
	#disposed = false;
	#recalledContent: RemoteV2PromptContent | undefined;
	#recalledText: string | undefined;
	#pendingAttachments: RemoteV2PromptContent = [];
	readonly #openSettings: (() => void) | undefined;
	readonly #openModel: (() => void) | undefined;
	readonly #openLogin: ((providerId?: string, type?: "oauth" | "api_key") => void) | undefined;
	readonly #openResume: (() => void) | undefined;
	readonly #openFork: (() => void) | undefined;
	readonly #openTree: (() => void) | undefined;
	readonly #openScopedModels: (() => void) | undefined;
	readonly #openThinking: (() => void) | undefined;
	readonly #openTrust: (() => void) | undefined;
	readonly #exportSession: ((outputPath?: string) => Promise<string>) | undefined;
	readonly #importSession: ((inputPath: string) => Promise<string>) | undefined;
	readonly #shareSession: (() => Promise<string>) | undefined;
	readonly #quit: (() => void) | undefined;
	readonly #copyText: (text: string) => Promise<void>;
	readonly #readClipboardImage: () => Promise<ClipboardImage | null>;
	readonly #readClipboardText: () => Promise<string | null>;
	readonly #executeShell: ((command: string, excludeFromContext: boolean) => Promise<void>) | undefined;
	readonly #showChangelog: (() => void) | undefined;
	readonly #showDebug: (() => Promise<string>) | undefined;
	readonly #showHotkeys: (() => void) | undefined;
	readonly #showSession: (() => void) | undefined;
	readonly #cwd: string | undefined;

	constructor(
		attachment: RemoteV2SessionAttachment,
		editor?: RemoteInteractiveEditor,
		options: {
			readonly openSettings?: () => void;
			readonly openModel?: () => void;
			readonly openLogin?: (providerId?: string, type?: "oauth" | "api_key") => void;
			readonly openResume?: () => void;
			readonly openFork?: () => void;
			readonly openTree?: () => void;
			readonly openScopedModels?: () => void;
			readonly openThinking?: () => void;
			readonly openTrust?: () => void;
			readonly exportSession?: (outputPath?: string) => Promise<string>;
			readonly importSession?: (inputPath: string) => Promise<string>;
			readonly shareSession?: () => Promise<string>;
			readonly quit?: () => void;
			readonly copyText?: (text: string) => Promise<void>;
			readonly readClipboardImage?: () => Promise<ClipboardImage | null>;
			readonly readClipboardText?: () => Promise<string | null>;
			readonly executeShell?: (command: string, excludeFromContext: boolean) => Promise<void>;
			readonly showChangelog?: () => void;
			readonly showDebug?: () => Promise<string>;
			readonly showHotkeys?: () => void;
			readonly showSession?: () => void;
			readonly cwd?: string;
		} = {},
	) {
		this.#attachment = attachment;
		this.#editor = editor;
		this.#openSettings = options.openSettings;
		this.#openModel = options.openModel;
		this.#openLogin = options.openLogin;
		this.#openResume = options.openResume;
		this.#openFork = options.openFork;
		this.#openTree = options.openTree;
		this.#openScopedModels = options.openScopedModels;
		this.#openThinking = options.openThinking;
		this.#openTrust = options.openTrust;
		this.#exportSession = options.exportSession;
		this.#importSession = options.importSession;
		this.#shareSession = options.shareSession;
		this.#quit = options.quit;
		this.#copyText = options.copyText ?? copyToClipboard;
		this.#readClipboardImage = options.readClipboardImage ?? readClipboardImage;
		this.#readClipboardText = options.readClipboardText ?? readClipboardText;
		this.#executeShell = options.executeShell;
		this.#showChangelog = options.showChangelog;
		this.#showDebug = options.showDebug;
		this.#showHotkeys = options.showHotkeys;
		this.#showSession = options.showSession;
		this.#cwd = options.cwd;
		if (editor !== undefined) {
			editor.setAutocompleteProvider(new RemoteV2AutocompleteProvider(attachment.session));
			editor.onSubmit = (text) => this.submitEditorText(text);
			editor.onEscape = () => {
				if (this.session.phase !== "turn") return;
				void this.session
					.abort()
					.then(() => this.view.showStatus("Aborting active turn"))
					.catch((error: unknown) => this.view.showStatus(error instanceof Error ? error.message : String(error)));
			};
			editor.onPasteImage = () => {
				void this.pasteClipboard().catch((error: unknown) => {
					this.view.showStatus(error instanceof Error ? error.message : String(error));
					this.view.invalidate();
				});
			};
			const previousOnChange = editor.onChange;
			editor.onChange = (text) => {
				if (this.#recalledContent !== undefined && text !== this.#recalledText) {
					this.#recalledContent = undefined;
					this.#recalledText = undefined;
				}
				if (text.length === 0) this.#pendingAttachments = [];
				previousOnChange?.(text);
			};
		}
	}

	get session(): RemoteV2SessionAttachment["session"] {
		return this.#attachment.session;
	}

	get view(): RemoteV2SessionAttachment["view"] {
		return this.#attachment.view;
	}

	submit(text: string): Promise<string> {
		this.#assertActive();
		return this.session.submit(text);
	}

	async dequeueAll(): Promise<number> {
		this.#assertActive();
		const snapshot = this.session.snapshot;
		const entries = snapshot === undefined ? [] : [...snapshot.queues.steer, ...snapshot.queues.followUp];
		const content: RemoteV2PromptContent[number][] = [];
		let recalledCount = 0;
		for (const entry of entries) {
			const recalled = await this.session.cancelQueued(entry.id);
			if (recalled === undefined) continue;
			recalledCount += 1;
			if (content.length > 0) content.push({ type: "text", text: "\n\n" });
			content.push(...recalled);
		}
		if (content.length === 0) return 0;
		this.#recalledContent = content;
		this.#recalledText = displayPromptContent(content);
		this.#editor?.setText(this.#recalledText);
		return recalledCount;
	}

	private async pasteClipboard(): Promise<void> {
		this.#assertActive();
		const image = await this.#readClipboardImage();
		if (image !== null) {
			const blob = await this.session.putBlob(Buffer.from(image.bytes).toString("base64"), image.mimeType);
			this.#recalledContent = undefined;
			this.#recalledText = undefined;
			this.#pendingAttachments = [
				...this.#pendingAttachments,
				{ type: "image", digest: blob.digest, mimeType: blob.mimeType },
			];
			this.view.showStatus(`Image attached: ${blob.mimeType}`);
			this.view.invalidate();
			return;
		}
		const text = await this.#readClipboardText();
		if (text === null) return;
		this.#editor?.insertTextAtCursor?.(text);
		this.view.invalidate();
	}

	async execute(input: string): Promise<RemoteV2CommandResult> {
		this.#assertActive();
		let command: RemoteV2Command;
		try {
			command = parseRemoteV2Command(input);
		} catch (error) {
			if (await this.#isInteractiveResourceInvocation(input)) return operation(await this.session.submit(input));
			throw error;
		}
		switch (command.name) {
			case "abort":
				return operation(await this.session.abort());
			case "agent-follow-up": {
				const agent = await this.session.followUpAgent(command.agentId, command.text);
				return { kind: "status", text: `agent ${agent.state}` };
			}
			case "agent-interrupt": {
				const agent = await this.session.interruptAgent(command.agentId);
				return { kind: "status", text: `agent ${agent.state}` };
			}
			case "interrupt-child": {
				const agent = await this.session.interruptAgent(command.agentId);
				return { kind: "status", text: `agent ${agent.state}` };
			}
			case "agent-message":
				await this.session.messageAgent(command.agentId, command.text);
				return { kind: "status", text: "agent message sent" };
			case "compact":
				return operation(await this.session.compact(command.instructions));
			case "clone":
				return {
					kind: "status",
					text: `Cloned to new session: ${await this.session.forkAndAttach({ scope: "tree" })}`,
				};
			case "copy": {
				const text = getLastRemoteAssistantText(this.session.snapshot);
				if (text === undefined) throw new Error("No agent messages to copy yet.");
				await this.#copyText(text);
				return { kind: "status", text: "Copied last agent message to clipboard" };
			}
			case "debug":
				if (this.#showDebug === undefined) throw new Error("Remote debug capture is unavailable");
				return { kind: "status", text: `Debug log written: ${await this.#showDebug()}` };
			case "changelog":
				if (this.#showChangelog === undefined) throw new Error("Remote changelog is unavailable");
				this.#showChangelog();
				return { kind: "status", text: "changelog opened" };
			case "dequeue":
				this.#recalledContent = await this.session.cancelQueued(command.entryId);
				this.#recalledText = this.#recalledContent === undefined ? "" : displayPromptContent(this.#recalledContent);
				this.#editor?.setText(this.#recalledText);
				return { kind: "status", text: "queued message recalled" };
			case "detach":
				await this.dispose();
				return { kind: "detached" };
			case "export":
				if (this.#exportSession === undefined) throw new Error("Remote session export is unavailable");
				return { kind: "status", text: `Session exported to: ${await this.#exportSession(command.outputPath)}` };
			case "import":
				if (this.#importSession === undefined) throw new Error("Remote session import is unavailable");
				return { kind: "status", text: `Session imported from: ${await this.#importSession(command.inputPath)}` };
			case "share":
				if (this.#shareSession === undefined) throw new Error("Remote session sharing is unavailable");
				return { kind: "status", text: await this.#shareSession() };
			case "follow-up":
				return operation(await this.session.followUp(command.text));
			case "fork":
				if (this.#openFork === undefined) throw new Error("Remote session forking is unavailable");
				this.#openFork();
				return { kind: "status", text: "fork selector opened" };
			case "goal":
				return operation(await this.session.createGoal(command.objective));
			case "goal-pause":
				return operation(await this.session.pauseGoal());
			case "goal-resume":
				return operation(await this.session.resumeGoal());
			case "input":
				await this.session.respondInput(command.requestId, command.answers);
				return { kind: "status", text: "input answered" };
			case "input-cancel":
				await this.session.cancelInput(command.requestId);
				return { kind: "status", text: "input cancelled" };
			case "login":
				if (this.#openLogin === undefined) throw new Error("Remote login is unavailable");
				this.#openLogin(command.providerId, command.type);
				return { kind: "status", text: "login dialog opened" };
			case "hotkeys":
				if (this.#showHotkeys === undefined) throw new Error("Remote hotkeys are unavailable");
				this.#showHotkeys();
				return { kind: "status", text: "keyboard shortcuts opened" };
			case "model":
				if (!("provider" in command)) {
					if (this.#openModel === undefined) throw new Error("Remote model selection is unavailable");
					this.#openModel();
					return { kind: "status", text: "model selector opened" };
				}
				return operation(await this.session.setModel({ provider: command.provider, id: command.id }));
			case "logout": {
				if (command.providerId === undefined) {
					const providers = await this.session.listAuthenticatedProviders();
					return {
						kind: "status",
						text:
							providers.length === 0
								? "No server-stored credentials to remove"
								: `Use /logout <provider>: ${providers.map((provider) => provider.id).join(", ")}`,
					};
				}
				await this.session.logout(command.providerId);
				return { kind: "status", text: `Logged out of ${command.providerId}` };
			}
			case "name":
				if (command.generate) return operation(await this.session.generateName());
				if (command.clear) return operation(await this.session.setName(null));
				if (command.value === undefined) {
					const snapshot = this.session.snapshot;
					return {
						kind: "status",
						text:
							snapshot?.name === undefined
								? "(unnamed)"
								: `${snapshot.name} (${snapshot.nameSource ?? "unknown"})`,
					};
				}
				return operation(await this.session.setName(command.value));
			case "name-auto":
				return operation(await this.session.setAutoName(command.enabled));
			case "new": {
				const sessionId = await this.session.createAndAttach(this.#cwd === undefined ? {} : { cwd: this.#cwd });
				return { kind: "status", text: `New session started: ${sessionId}` };
			}
			case "plan":
				await this.session.updatePlan(command.items);
				return { kind: "status", text: "plan updated" };
			case "plan-clear":
				await this.session.clearPlan();
				return { kind: "status", text: "plan cleared" };
			case "plugins": {
				const plugins = await this.session.listPlugins(true);
				const summary = plugins
					.map((plugin) => {
						const id = typeof plugin.id === "string" ? plugin.id : "unknown";
						return plugin.enabled === true ? id : `${id} (disabled)`;
					})
					.join(", ");
				return { kind: "status", text: summary || "no installed plugins" };
			}
			case "quit":
				if (this.#quit === undefined) throw new Error("Remote session quit is unavailable");
				this.#quit();
				return { kind: "status", text: "Detached from session" };
			case "release-control":
				await this.session.relinquishControl();
				return { kind: "control", mode: "observer" };
			case "reload":
				await this.session.reload();
				return { kind: "status", text: "Reloaded server resources" };
			case "resume":
				if (this.#openResume !== undefined) {
					this.#openResume();
					return { kind: "status", text: "session selector opened" };
				}
				return operation(await this.session.resume());
			case "rollback":
				return operation(await this.session.rollback(command.turns));
			case "settings":
				if (this.#openSettings === undefined) throw new Error("Remote settings are unavailable");
				this.#openSettings();
				return { kind: "status", text: "settings opened" };
			case "session":
				if (this.#showSession === undefined) throw new Error("Remote session information is unavailable");
				this.#showSession();
				return { kind: "status", text: "session information opened" };
			case "scoped-models":
				if (this.#openScopedModels === undefined) throw new Error("Remote model scope is unavailable");
				this.#openScopedModels();
				return { kind: "status", text: "model scope opened" };
			case "statusline":
				if (!this.#attachment.setStatusline) throw new Error("Remote statusline is unavailable");
				await this.#attachment.setStatusline(command.command);
				return {
					kind: "status",
					text: command.command === undefined ? "statusline disabled" : "statusline updated",
				};
			case "steer":
				return operation(await this.session.submit(command.text));
			case "take-control":
				await this.session.acquireControl();
				return { kind: "control", mode: "control" };
			case "thinking":
				if (!("level" in command)) {
					if (this.#openThinking === undefined) throw new Error("Remote thinking selection is unavailable");
					this.#openThinking();
					return { kind: "status", text: "thinking selector opened" };
				}
				return operation(await this.session.setThinking(command.level));
			case "tree":
				if (this.#openTree === undefined) throw new Error("Remote session tree is unavailable");
				this.#openTree();
				return { kind: "status", text: "session tree opened" };
			case "trust":
				if (this.#openTrust === undefined) throw new Error("Remote project trust is unavailable");
				this.#openTrust();
				return { kind: "status", text: "project trust selector opened" };
		}
	}

	async #isInteractiveResourceInvocation(input: string): Promise<boolean> {
		const match = /^\/([^\s]+)(?:\s|$)/u.exec(input.trim());
		if (match === null) return false;
		const resources = await this.session.listInteractiveResources();
		return resources.some((resource) => resource.name === match[1]);
	}

	private submitEditorText(text: string): void {
		const input = text.trim();
		const recalledContent = this.#recalledContent;
		const pendingAttachments = this.#pendingAttachments;
		const content =
			recalledContent ??
			(pendingAttachments.length === 0
				? undefined
				: [...pendingAttachments, ...(input.length === 0 ? [] : [{ type: "text" as const, text }])]);
		if (input.length === 0 && content === undefined) return;
		this.#recalledContent = undefined;
		this.#recalledText = undefined;
		this.#pendingAttachments = [];
		this.#editor?.setText("");
		const action = input.startsWith("!")
			? this.executeShell(input)
			: input.startsWith("/")
				? this.execute(input)
				: (content === undefined ? this.submit(input) : this.session.submit(content)).then(
						(operationId) => `operation ${operationId}`,
					);
		void action
			.then((result) => {
				if (typeof result !== "string") this.view.showStatus(formatRemoteV2CommandResult(result));
				this.view.invalidate();
			})
			.catch((error: unknown) => {
				this.view.showStatus(error instanceof Error ? error.message : String(error));
				this.view.invalidate();
			});
	}

	private executeShell(input: string): Promise<string> {
		if (this.#executeShell === undefined) return Promise.reject(new Error("Remote shell execution is unavailable"));
		const excludeFromContext = input.startsWith("!!");
		const command = input.slice(excludeFromContext ? 2 : 1).trim();
		if (command.length === 0) return Promise.resolve("shell command ignored");
		return this.#executeShell(command, excludeFromContext).then(() => "shell command started");
	}

	dispose(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#disposed = true;
		return this.#attachment.dispose();
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Remote v2 interactive attachment is disposed");
	}
}

function displayPromptContent(content: RemoteV2PromptContent): string {
	return content
		.map((part) => {
			switch (part.type) {
				case "text":
					return part.text;
				case "image":
					return `[image:${part.mimeType}]`;
				case "blob":
					return `[blob:${part.mimeType}]`;
				case "mention":
					return `@${part.name}:${part.path}`;
				default:
					return "";
			}
		})
		.join("\n");
}

function operation(operationId: string): RemoteV2CommandResult {
	return { kind: "operation", operationId };
}

function formatRemoteV2CommandResult(result: RemoteV2CommandResult): string {
	if (result.kind === "status") return result.text;
	if (result.kind === "control") return `Control mode: ${result.mode}`;
	if (result.kind === "operation") return `Operation accepted: ${result.operationId}`;
	return "Detached from server session";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
