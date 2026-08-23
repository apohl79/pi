import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { RemoteV2Session, RemoteV2SessionState } from "./remote-v2-session.ts";
import { stripAnsi } from "../utils/ansi.ts";

export interface RemoteV2SessionViewOptions {
	readonly maxTranscriptItems?: number;
	readonly maxTranscriptCharacters?: number;
	readonly maxAgentItems?: number;
}

const DEFAULT_MAX_TRANSCRIPT_ITEMS = 48;
const DEFAULT_MAX_TRANSCRIPT_CHARACTERS = 6_000;
const DEFAULT_MAX_AGENT_ITEMS = 12;
const MAX_TRANSCRIPT_ITEMS = 10_000;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;
const MAX_AGENT_ITEMS = 1_000;

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function normalizeOptions(options: RemoteV2SessionViewOptions): Required<RemoteV2SessionViewOptions> {
	return {
		maxTranscriptItems: normalizeLimit(options.maxTranscriptItems, DEFAULT_MAX_TRANSCRIPT_ITEMS, MAX_TRANSCRIPT_ITEMS),
		maxTranscriptCharacters: normalizeLimit(
			options.maxTranscriptCharacters,
			DEFAULT_MAX_TRANSCRIPT_CHARACTERS,
			MAX_TRANSCRIPT_CHARACTERS,
		),
		maxAgentItems: normalizeLimit(options.maxAgentItems, DEFAULT_MAX_AGENT_ITEMS, MAX_AGENT_ITEMS),
	};
}

/** Renderable TUI projection of one server-authoritative v2 session. */
export class RemoteV2SessionView implements Component {
	readonly #options: Required<RemoteV2SessionViewOptions>;
	#state: RemoteV2SessionState;
	readonly #unsubscribe: () => void;

	constructor(session: RemoteV2Session, options: RemoteV2SessionViewOptions = {}) {
		this.#options = normalizeOptions(options);
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
	const normalizedOptions = normalizeOptions(options);
	const snapshot = state.snapshot;
	if (!snapshot) return `Session ${state.lifecycle.status}`;
	const maxItems = normalizedOptions.maxTranscriptItems;
	const maxCharacters = normalizedOptions.maxTranscriptCharacters;
	const model = `${sanitizeTranscriptText(snapshot.model.provider)}/${sanitizeTranscriptText(snapshot.model.id)}`;
	const operation =
		state.lifecycle.status === "busy" ? ` operation=${sanitizeTranscriptText(state.lifecycle.operationId)}` : "";
	const lines = [
		`Session ${sanitizeTranscriptText(snapshot.id)} · phase=${sanitizeTranscriptText(snapshot.phase)} · model=${model}${operation}`,
	];
	for (const agent of snapshot.agents.slice(0, normalizedOptions.maxAgentItems))
		lines.push(
			`Agent ${sanitizeTranscriptText(agent.path)} · ${sanitizeTranscriptText(agent.state)} · ${sanitizeTranscriptText(agent.model.provider)}/${sanitizeTranscriptText(agent.model.id)}`,
		);
	let characters = 0;
	const transcript = maxItems === 0 ? [] : snapshot.transcript.slice(-maxItems);
	for (const item of transcript) {
		const text = sanitizeTranscriptText(transcriptText(item));
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

function sanitizeTranscriptText(value: string): string {
	return stripAnsi(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
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
