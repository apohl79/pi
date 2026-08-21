import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { RemoteV2Session, RemoteV2SessionState } from "./remote-v2-session.ts";

export interface RemoteV2SessionViewOptions {
	readonly maxTranscriptItems?: number;
	readonly maxTranscriptCharacters?: number;
}

/** Renderable TUI projection of one server-authoritative v2 session. */
export class RemoteV2SessionView implements Component {
	readonly #options: Required<RemoteV2SessionViewOptions>;
	#state: RemoteV2SessionState;
	readonly #unsubscribe: () => void;

	constructor(session: RemoteV2Session, options: RemoteV2SessionViewOptions = {}) {
		this.#options = {
			maxTranscriptItems: options.maxTranscriptItems ?? 48,
			maxTranscriptCharacters: options.maxTranscriptCharacters ?? 6_000,
		};
		this.#state = session.state;
		this.#unsubscribe = session.subscribe((state) => {
			this.#state = state;
		});
	}

	render(width: number): string[] {
		return new Text(formatRemoteV2Session(this.#state, this.#options), 0, 0).render(Math.max(1, width));
	}

	invalidate(): void {}

	dispose(): void {
		this.#unsubscribe();
	}
}

export function formatRemoteV2Session(state: RemoteV2SessionState, options: RemoteV2SessionViewOptions = {}): string {
	const snapshot = state.snapshot;
	if (!snapshot) return `Session ${state.lifecycle.status}`;
	const maxItems = options.maxTranscriptItems ?? 48;
	const maxCharacters = options.maxTranscriptCharacters ?? 6_000;
	const model = `${snapshot.model.provider}/${snapshot.model.id}`;
	const operation = state.lifecycle.status === "busy" ? ` operation=${state.lifecycle.operationId}` : "";
	const lines = [`Session ${snapshot.id} · phase=${snapshot.phase} · model=${model}${operation}`];
	let characters = 0;
	for (const item of snapshot.transcript.slice(-maxItems)) {
		const text = transcriptText(item);
		if (!text) continue;
		const line = `${item.role}: ${text}`;
		if (characters + line.length > maxCharacters) {
			const remaining = Math.max(0, maxCharacters - characters);
			if (remaining > 0) lines.push(`${line.slice(0, remaining)}…`);
			break;
		}
		lines.push(line);
		characters += line.length;
	}
	return lines.join("\n");
}

function transcriptText(item: TranscriptItem): string {
	if (item.role === "tool") {
		return (
			item.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("") || `[${item.toolName} ${item.status}]`
		);
	}
	return item.content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return `[thinking] ${part.thinking}`;
			if (part.type === "toolCall") return `[tool ${part.toolName}]`;
			return `[image ${part.mimeType}]`;
		})
		.join("");
}
