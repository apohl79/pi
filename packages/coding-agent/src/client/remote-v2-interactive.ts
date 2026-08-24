import type { PlanItem, ThinkingLevel } from "@earendil-works/pi-protocol";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Editor,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { RemoteV2SessionAttachment } from "./remote-v2-selector.ts";
import type { RemoteV2FileCompletion, RemoteV2PromptContent } from "./remote-v2-session.ts";

export const REMOTE_V2_SLASH_COMMANDS = [
	"/model",
	"/abort",
	"/agent-follow-up",
	"/agent-interrupt",
	"/agent-message",
	"/compact",
	"/clone",
	"/dequeue",
	"/detach",
	"/follow-up",
	"/fork",
	"/goal",
	"/goal-pause",
	"/goal-resume",
	"/input",
	"/input-cancel",
	"/interrupt-child",
	"/name",
	"/name-auto",
	"/new",
	"/plan",
	"/plan-clear",
	"/plugins",
	"/release-control",
	"/resume",
	"/rollback",
	"/settings",
	"/scoped-models",
	"/statusline",
	"/steer",
	"/take-control",
	"/thinking",
] as const;

export type RemoteV2Command =
	| { readonly name: "abort" }
	| { readonly name: "agent-follow-up"; readonly agentId: string; readonly text: string }
	| { readonly name: "agent-interrupt"; readonly agentId: string }
	| { readonly name: "interrupt-child"; readonly agentId: string }
	| { readonly name: "agent-message"; readonly agentId: string; readonly text: string }
	| { readonly name: "compact"; readonly instructions?: string }
	| { readonly name: "clone" }
	| { readonly name: "dequeue"; readonly entryId: string }
	| { readonly name: "detach" }
	| { readonly name: "follow-up"; readonly text: string }
	| { readonly name: "fork" }
	| { readonly name: "goal"; readonly objective: string }
	| { readonly name: "goal-pause" }
	| { readonly name: "goal-resume" }
	| { readonly name: "input"; readonly requestId: string; readonly answers: Readonly<Record<string, string>> }
	| { readonly name: "input-cancel"; readonly requestId: string }
	| { readonly name: "model" }
	| { readonly name: "model"; readonly provider: string; readonly id: string }
	| { readonly name: "name"; readonly value?: string; readonly clear?: boolean; readonly generate?: boolean }
	| { readonly name: "name-auto"; readonly enabled: boolean }
	| { readonly name: "new" }
	| { readonly name: "plan"; readonly items: readonly PlanItem[] }
	| { readonly name: "plan-clear" }
	| { readonly name: "plugins" }
	| { readonly name: "release-control" }
	| { readonly name: "resume" }
	| { readonly name: "rollback"; readonly turns: number }
	| { readonly name: "settings" }
	| { readonly name: "scoped-models" }
	| { readonly name: "statusline"; readonly command?: string }
	| { readonly name: "steer"; readonly text: string }
	| { readonly name: "take-control" }
	| { readonly name: "thinking" }
	| { readonly name: "thinking"; readonly level: ThinkingLevel };

export type RemoteV2CommandResult =
	| { readonly kind: "operation"; readonly operationId: string }
	| { readonly kind: "control"; readonly mode: "control" | "observer" }
	| { readonly kind: "status"; readonly text: string }
	| { readonly kind: "detached" };

type RemoteFileAutocompleteItem = AutocompleteItem & Pick<RemoteV2FileCompletion, "kind" | "reference">;

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
		const command = this.commandSuggestions(input);
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
				: `${beforePrefix}/${item.value} `;
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

	commandSuggestions(input: string): AutocompleteSuggestions | null {
		if (!input.startsWith("/") || /\s/u.test(input)) return null;
		const prefix = input.slice(1);
		const items = fuzzyFilter(
			REMOTE_V2_SLASH_COMMANDS.map((command) => ({ value: command.slice(1), label: command.slice(1) })),
			prefix,
			(item) => item.value,
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
		name === "/detach" ||
		name === "/fork" ||
		name === "/release-control" ||
		name === "/resume" ||
		name === "/scoped-models" ||
		name === "/take-control"
	) {
		if (arguments_.length > 0) throw new Error(`${name} does not accept arguments`);
		return { name: name.slice(1) as RemoteV2Command["name"] } as RemoteV2Command;
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
	if (name === "/model") {
		if (arguments_.length === 0) return { name: "model" };
		if (arguments_.length !== 1) throw new Error("/model requires <provider/model>");
		const separator = arguments_[0].indexOf("/");
		if (separator < 1 || separator === arguments_[0].length - 1) throw new Error("/model requires <provider/model>");
		return { name: "model", provider: arguments_[0].slice(0, separator), id: arguments_[0].slice(separator + 1) };
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

/** Binds server-backed commands and completions to the shared interactive editor. */
export class RemoteV2InteractiveAttachment {
	readonly #attachment: RemoteV2SessionAttachment;
	readonly #editor: Editor | undefined;
	#disposed = false;
	#recalledContent: RemoteV2PromptContent | undefined;
	#recalledText: string | undefined;
	readonly #openSettings: (() => void) | undefined;
	readonly #openModel: (() => void) | undefined;
	readonly #openResume: (() => void) | undefined;
	readonly #openFork: (() => void) | undefined;
	readonly #openScopedModels: (() => void) | undefined;
	readonly #openThinking: (() => void) | undefined;
	readonly #cwd: string | undefined;

	constructor(
		attachment: RemoteV2SessionAttachment,
		editor?: Editor,
		options: {
			readonly openSettings?: () => void;
			readonly openModel?: () => void;
			readonly openResume?: () => void;
			readonly openFork?: () => void;
			readonly openScopedModels?: () => void;
			readonly openThinking?: () => void;
			readonly cwd?: string;
		} = {},
	) {
		this.#attachment = attachment;
		this.#editor = editor;
		this.#openSettings = options.openSettings;
		this.#openModel = options.openModel;
		this.#openResume = options.openResume;
		this.#openFork = options.openFork;
		this.#openScopedModels = options.openScopedModels;
		this.#openThinking = options.openThinking;
		this.#cwd = options.cwd;
		if (editor !== undefined) {
			editor.setAutocompleteProvider(new RemoteV2AutocompleteProvider(attachment.session));
			editor.onSubmit = (text) => this.submitEditorText(text);
			const previousOnChange = editor.onChange;
			editor.onChange = (text) => {
				if (this.#recalledContent !== undefined && text !== this.#recalledText) {
					this.#recalledContent = undefined;
					this.#recalledText = undefined;
				}
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

	async execute(input: string): Promise<RemoteV2CommandResult> {
		this.#assertActive();
		const command = parseRemoteV2Command(input);
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
			case "dequeue":
				this.#recalledContent = await this.session.cancelQueued(command.entryId);
				this.#recalledText = this.#recalledContent === undefined ? "" : displayPromptContent(this.#recalledContent);
				this.#editor?.setText(this.#recalledText);
				return { kind: "status", text: "queued message recalled" };
			case "detach":
				await this.dispose();
				return { kind: "detached" };
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
			case "model":
				if (!("provider" in command)) {
					if (this.#openModel === undefined) throw new Error("Remote model selection is unavailable");
					this.#openModel();
					return { kind: "status", text: "model selector opened" };
				}
				return operation(await this.session.setModel({ provider: command.provider, id: command.id }));
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
			case "release-control":
				await this.session.relinquishControl();
				return { kind: "control", mode: "observer" };
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
		}
	}

	private submitEditorText(text: string): void {
		const input = text.trim();
		if (!input) return;
		const recalledContent = this.#recalledContent;
		this.#recalledContent = undefined;
		this.#recalledText = undefined;
		this.#editor?.setText("");
		const action = input.startsWith("/")
			? this.execute(input)
			: (recalledContent === undefined ? this.submit(input) : this.session.submit(recalledContent)).then(
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
