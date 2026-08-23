import type { PlanItem, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { Component } from "@earendil-works/pi-tui";
import type { RemoteV2SessionAttachment } from "./remote-v2-selector.ts";
import type { RemoteV2FileCompletion, RemoteV2PromptContent } from "./remote-v2-session.ts";

export const REMOTE_V2_SLASH_COMMANDS = [
	"/abort",
	"/agent-follow-up",
	"/agent-interrupt",
	"/agent-message",
	"/compact",
	"/dequeue",
	"/detach",
	"/follow-up",
	"/goal",
	"/goal-pause",
	"/goal-resume",
	"/input",
	"/input-cancel",
	"/interrupt-child",
	"/model",
	"/name",
	"/name-auto",
	"/plan",
	"/plan-clear",
	"/plugins",
	"/release-control",
	"/resume",
	"/rollback",
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
	| { readonly name: "dequeue"; readonly entryId: string }
	| { readonly name: "detach" }
	| { readonly name: "follow-up"; readonly text: string }
	| { readonly name: "goal"; readonly objective: string }
	| { readonly name: "goal-pause" }
	| { readonly name: "goal-resume" }
	| { readonly name: "input"; readonly requestId: string; readonly answers: Readonly<Record<string, string>> }
	| { readonly name: "input-cancel"; readonly requestId: string }
	| { readonly name: "model"; readonly provider: string; readonly id: string }
	| { readonly name: "name"; readonly value?: string; readonly clear?: boolean; readonly generate?: boolean }
	| { readonly name: "name-auto"; readonly enabled: boolean }
	| { readonly name: "plan"; readonly items: readonly PlanItem[] }
	| { readonly name: "plan-clear" }
	| { readonly name: "plugins" }
	| { readonly name: "release-control" }
	| { readonly name: "resume" }
	| { readonly name: "rollback"; readonly turns: number }
	| { readonly name: "statusline"; readonly command?: string }
	| { readonly name: "steer"; readonly text: string }
	| { readonly name: "take-control" }
	| { readonly name: "thinking"; readonly level: ThinkingLevel };

export type RemoteV2CommandResult =
	| { readonly kind: "operation"; readonly operationId: string }
	| { readonly kind: "control"; readonly mode: "control" | "observer" }
	| { readonly kind: "status"; readonly text: string }
	| { readonly kind: "detached" };

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
		name === "/detach" ||
		name === "/release-control" ||
		name === "/resume" ||
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
		if (arguments_.length !== 1 || !isThinkingLevel(arguments_[0]))
			throw new Error("/thinking requires a valid level");
		return { name: "thinking", level: arguments_[0] };
	}
	throw new Error(`Unknown remote session command: ${name || "<empty>"}`);
}

/** Compatibility-safe command and rendering boundary for a remote v2 attachment. */
export class RemoteV2InteractiveAttachment implements Component {
	readonly #attachment: RemoteV2SessionAttachment;
	static readonly MAX_INPUT_LENGTH = 4_000;
	#disposed = false;
	#input = "";
	#recalledContent: RemoteV2PromptContent | undefined;
	#status = "";
	#completionSequence = 0;

	constructor(attachment: RemoteV2SessionAttachment) {
		this.#attachment = attachment;
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
			case "dequeue":
				this.#recalledContent = await this.session.cancelQueued(command.entryId);
				this.#input = this.#recalledContent === undefined ? "" : displayPromptContent(this.#recalledContent);
				return { kind: "status", text: "queued message recalled" };
			case "detach":
				await this.dispose();
				return { kind: "detached" };
			case "follow-up":
				return operation(await this.session.followUp(command.text));
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
				return operation(await this.session.resume());
			case "rollback":
				return operation(await this.session.rollback(command.turns));
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
				return operation(await this.session.setThinking(command.level));
		}
	}

	render(width: number): string[] {
		this.#assertActive();
		return [...this.view.render(width), `${this.#status ? `${this.#status} ` : ""}> ${this.#input}`];
	}

	invalidate(): void {
		this.view.invalidate();
	}

	handleInput(data: string): void {
		this.#assertActive();
		if (data.length > 1) {
			for (const character of data) this.handleInput(character);
			return;
		}
		if (data === "\r" || data === "\n") {
			const input = this.#input.trim();
			const recalledContent = this.#recalledContent;
			this.#recalledContent = undefined;
			this.#input = "";
			if (!input) return;
			const action = input.startsWith("/")
				? this.execute(input).then((result) =>
						result.kind === "operation" ? `operation ${result.operationId}` : result.kind,
					)
				: (recalledContent === undefined ? this.submit(input) : this.session.submit(recalledContent)).then(
						(operationId) => `operation ${operationId}`,
					);
			void action
				.then((result) => {
					this.#status = result;
					this.invalidate();
				})
				.catch((error: unknown) => {
					this.#status = error instanceof Error ? error.message : String(error);
					this.invalidate();
				});
			return;
		}
		if (data === "\u007f" || data === "\b") {
			this.#recalledContent = undefined;
			this.#completionSequence++;
			this.#input = this.#input.slice(0, -1);
			this.invalidate();
			return;
		}
		if (data === "\t") {
			this.#recalledContent = undefined;
			void this.completeInput();
			return;
		}
		if (
			data.length === 1 &&
			data >= " " &&
			data !== "\u007f" &&
			this.#input.length < RemoteV2InteractiveAttachment.MAX_INPUT_LENGTH
		) {
			this.#recalledContent = undefined;
			this.#completionSequence++;
			this.#input += data;
			this.invalidate();
		}
	}

	private async completeInput(): Promise<void> {
		const sequence = ++this.#completionSequence;
		this.#recalledContent = undefined;
		const tokenStart = Math.max(this.#input.lastIndexOf(" "), this.#input.lastIndexOf("\t")) + 1;
		const prefix = this.#input.slice(tokenStart);
		if (!prefix.startsWith("@")) return;
		try {
			const items = await this.session.completeFiles(prefix, { requestId: `completion-${sequence}` });
			if (sequence !== this.#completionSequence || this.#input.slice(tokenStart) !== prefix) return;
			const item = items[0];
			if (item === undefined) return;
			this.#input = applyRemoteFileCompletion(this.#input, tokenStart, item);
			this.invalidate();
		} catch (error: unknown) {
			if (sequence === this.#completionSequence)
				this.#status = error instanceof Error ? error.message : String(error);
			this.invalidate();
		}
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

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
