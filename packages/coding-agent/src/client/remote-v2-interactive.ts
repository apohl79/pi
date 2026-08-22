import type { ThinkingLevel } from "@earendil-works/pi-protocol";
import type { Component } from "@earendil-works/pi-tui";
import type { RemoteV2SessionAttachment } from "./remote-v2-selector.ts";

export const REMOTE_V2_SLASH_COMMANDS = [
	"/abort",
	"/detach",
	"/follow-up",
	"/goal",
	"/goal-pause",
	"/goal-resume",
	"/model",
	"/name",
	"/name-auto",
	"/release-control",
	"/resume",
	"/rollback",
	"/take-control",
	"/thinking",
] as const;

export type RemoteV2Command =
	| { readonly name: "abort" }
	| { readonly name: "detach" }
	| { readonly name: "follow-up"; readonly text: string }
	| { readonly name: "goal"; readonly objective: string }
	| { readonly name: "goal-pause" }
	| { readonly name: "goal-resume" }
	| { readonly name: "model"; readonly provider: string; readonly id: string }
	| { readonly name: "name"; readonly value?: string; readonly clear?: boolean; readonly generate?: boolean }
	| { readonly name: "name-auto"; readonly enabled: boolean }
	| { readonly name: "release-control" }
	| { readonly name: "resume" }
	| { readonly name: "rollback"; readonly turns: number }
	| { readonly name: "take-control" }
	| { readonly name: "thinking"; readonly level: ThinkingLevel };

export type RemoteV2CommandResult =
	| { readonly kind: "operation"; readonly operationId: string }
	| { readonly kind: "control"; readonly mode: "control" | "observer" }
	| { readonly kind: "status"; readonly text: string }
	| { readonly kind: "detached" };

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
	if (name === "/goal") {
		const objective = arguments_.join(" ").trim();
		if (!objective) throw new Error("/goal requires objective");
		return { name: "goal", objective };
	}
	if (name === "/goal-pause" || name === "/goal-resume") {
		if (arguments_.length > 0) throw new Error(`${name} does not accept arguments`);
		return { name: name.slice(1) as "goal-pause" | "goal-resume" };
	}
	if (name === "/model") {
		if (arguments_.length !== 1) throw new Error("/model requires <provider/model>");
		const separator = arguments_[0].indexOf("/");
		if (separator < 1 || separator === arguments_[0].length - 1) throw new Error("/model requires <provider/model>");
		return { name: "model", provider: arguments_[0].slice(0, separator), id: arguments_[0].slice(separator + 1) };
	}
	if (name === "/name") {
		if (arguments_.length === 0) return { name: "name" };
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
	if (name === "/rollback") {
		const turns = arguments_.length === 0 ? 1 : Number(arguments_[0]);
		if (arguments_.length > 1 || !Number.isInteger(turns) || turns < 1) {
			throw new Error("/rollback requires a positive integer turn count");
		}
		return { name: "rollback", turns };
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
	#status = "";

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
			case "release-control":
				await this.session.relinquishControl();
				return { kind: "control", mode: "observer" };
			case "resume":
				return operation(await this.session.resume());
			case "rollback":
				return operation(await this.session.rollback(command.turns));
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
			this.#input = "";
			if (!input) return;
			const action = input.startsWith("/")
				? this.execute(input).then((result) =>
						result.kind === "operation" ? `operation ${result.operationId}` : result.kind,
					)
				: this.submit(input).then((operationId) => `operation ${operationId}`);
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
			this.#input = this.#input.slice(0, -1);
			this.invalidate();
			return;
		}
		if (
			data.length === 1 &&
			data >= " " &&
			data !== "\u007f" &&
			this.#input.length < RemoteV2InteractiveAttachment.MAX_INPUT_LENGTH
		) {
			this.#input += data;
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

function operation(operationId: string): RemoteV2CommandResult {
	return { kind: "operation", operationId };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
