import type { ThinkingLevel } from "@earendil-works/pi-protocol";
import type { Component } from "@earendil-works/pi-tui";
import type { RemoteV2SessionAttachment } from "./remote-v2-selector.ts";

export const REMOTE_V2_SLASH_COMMANDS = [
	"/abort",
	"/detach",
	"/follow-up",
	"/model",
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
	| { readonly name: "model"; readonly provider: string; readonly id: string }
	| { readonly name: "release-control" }
	| { readonly name: "resume" }
	| { readonly name: "rollback"; readonly turns: number }
	| { readonly name: "take-control" }
	| { readonly name: "thinking"; readonly level: ThinkingLevel };

export type RemoteV2CommandResult =
	| { readonly kind: "operation"; readonly operationId: string }
	| { readonly kind: "control"; readonly mode: "control" | "observer" }
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
	if (name === "/model") {
		if (arguments_.length !== 1) throw new Error("/model requires <provider/model>");
		const separator = arguments_[0].indexOf("/");
		if (separator < 1 || separator === arguments_[0].length - 1) throw new Error("/model requires <provider/model>");
		return { name: "model", provider: arguments_[0].slice(0, separator), id: arguments_[0].slice(separator + 1) };
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
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

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
			case "model":
				return operation(await this.session.setModel({ provider: command.provider, id: command.id }));
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
		return this.view.render(width);
	}

	invalidate(): void {
		this.view.invalidate();
	}

	dispose(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposePromise = this.#attachment.dispose().then(
			() => {
				this.#disposed = true;
			},
			(error: unknown) => {
				this.#disposePromise = undefined;
				throw error;
			},
		);
		return this.#disposePromise;
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
