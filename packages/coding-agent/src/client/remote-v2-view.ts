import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { StatuslineRunner, StatuslineSnapshot } from "../server/statusline.ts";
import type { RemoteV2Session, RemoteV2SessionState } from "./remote-v2-session.ts";

export interface RemoteV2SessionViewOptions {
	readonly maxTranscriptItems?: number;
	readonly maxTranscriptCharacters?: number;
	readonly maxAgentItems?: number;
	readonly maxPlanItems?: number;
	readonly maxGoalCharacters?: number;
}

export interface RemoteV2StatuslinePayloadOptions {
	readonly cwd: string;
	readonly transcriptPath: string;
	readonly projectDir?: string;
	readonly addedDirs?: readonly string[];
}

export interface RemoteV2StatuslinePayload {
	readonly harness: "pi";
	readonly session_id: string;
	readonly transcript_path: string;
	readonly cwd: string;
	readonly session_name?: string;
	readonly model: { readonly id: string; readonly display_name: string; readonly provider: string };
	readonly effort: { readonly level: string };
	readonly workspace: {
		readonly current_dir: string;
		readonly project_dir?: string;
		readonly added_dirs: readonly string[];
	};
	readonly cost: { readonly total_cost_usd?: number; readonly image_units: number; readonly pricing_state: string };
	readonly context_window: {
		readonly total_input_tokens: number;
		readonly total_output_tokens: number;
		readonly context_window_size: number;
		readonly used_percentage: number;
		readonly remaining_percentage: number;
	};
	readonly task_indicator: { readonly text: string; readonly completed: number; readonly total: number };
	readonly goal?: { readonly status: string; readonly remaining_tokens?: number };
	readonly agents: { readonly active: number; readonly total: number; readonly total_cost_usd?: number };
	readonly server: { readonly connected: boolean; readonly phase: string; readonly detachable: boolean };
}

export interface RemoteV2StatuslineSource {
	readonly state: RemoteV2SessionState;
	subscribe(listener: (state: RemoteV2SessionState) => void): () => void;
}

/** Runs statusline commands locally while consuming server-authoritative session state. */
export class RemoteV2StatuslineController {
	readonly #runner: StatuslineRunner;
	readonly #source: RemoteV2StatuslineSource;
	readonly #options: RemoteV2StatuslinePayloadOptions;
	readonly #unsubscribe: () => void;
	readonly #onUpdated?: () => void;
	#snapshot: StatuslineSnapshot = { pending: false };
	#command: string | readonly string[] | undefined;

	constructor(
		source: RemoteV2StatuslineSource,
		runner: StatuslineRunner,
		options: RemoteV2StatuslinePayloadOptions,
		onUpdated?: () => void,
	) {
		this.#onUpdated = onUpdated;
		this.#source = source;
		this.#runner = runner;
		this.#options = options;
		this.#unsubscribe = source.subscribe((state) => {
			void this.refresh(state);
		});
	}

	get snapshot(): StatuslineSnapshot {
		return structuredClone(this.#snapshot);
	}

	async refresh(state = this.#source.state): Promise<StatuslineSnapshot> {
		const payload = createRemoteV2StatuslinePayload(state, this.#options);
		if (payload === undefined) return this.snapshot;
		this.#snapshot = await this.#runner.update(payload, this.#command);
		this.#onUpdated?.();
		return this.snapshot;
	}

	setCommand(command: string | undefined): Promise<StatuslineSnapshot> {
		this.#command = command;
		return this.refresh();
	}

	async dispose(): Promise<void> {
		this.#unsubscribe();
		await this.#runner.dispose();
	}
}

/** Local client-host statusline projection for the server-default remote TUI. */
export class RemoteV2StatuslineComponent implements Component {
	readonly #controller: RemoteV2StatuslineController;
	#snapshot: StatuslineSnapshot = { pending: false };

	constructor(
		source: RemoteV2StatuslineSource,
		runner: StatuslineRunner,
		options: RemoteV2StatuslinePayloadOptions,
		onUpdated: () => void,
	) {
		this.#controller = new RemoteV2StatuslineController(source, runner, options, () => {
			this.#snapshot = this.#controller.snapshot;
			onUpdated();
		});
		this.#snapshot = this.#controller.snapshot;
	}

	setCommand(command: string | undefined): Promise<StatuslineSnapshot> {
		return this.#controller.setCommand(command);
	}

	render(width: number): string[] {
		void width;
		if (this.#snapshot.output) return [this.#snapshot.output];
		if (this.#snapshot.error) return [`statusline error: ${this.#snapshot.error}`];
		return [];
	}

	invalidate(): void {}

	dispose(): void {
		void this.#controller.dispose();
	}
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
			maxAgentItems: options.maxAgentItems ?? 12,
			maxPlanItems: options.maxPlanItems ?? 12,
			maxGoalCharacters: options.maxGoalCharacters ?? 240,
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
	const operation =
		state.lifecycle.status === "busy"
			? ` operation=${state.lifecycle.operationId}`
			: snapshot.activeOperation === undefined
				? ""
				: ` operation=${snapshot.activeOperation.operationId} (${snapshot.activeOperation.state})`;
	const lines = [`Session ${snapshot.id} · phase=${snapshot.phase} · model=${model}${operation}`];
	const cost = snapshot.usage.costUsd === undefined ? "unknown" : `$${snapshot.usage.costUsd.toFixed(6)}`;
	lines.push(
		`Usage input=${snapshot.usage.input} output=${snapshot.usage.output} cacheRead=${snapshot.usage.cacheRead} cost=${cost}`,
	);
	if (snapshot.persistence.recoveryState !== "clean") lines.push(`Persistence ${snapshot.persistence.recoveryState}`);
	if (snapshot.diagnostics.degraded) lines.push("Diagnostics degraded");
	for (const agent of snapshot.agents.slice(0, options.maxAgentItems ?? 12)) {
		const usage = agent.usage;
		const duration = agent.startedAt === undefined ? "" : ` · ${formatAgentDuration(agent.startedAt)}`;
		const usageText =
			usage === undefined
				? ""
				: ` · ↓${usage.input} ↑${usage.output}${usage.costUsd === undefined ? "" : ` $${usage.costUsd.toFixed(2)}`}`;
		lines.push(
			`Agent ${agent.path} · ${agent.state} · ${agent.model.provider}/${agent.model.id}${duration}${usageText}`,
		);
	}
	if (snapshot.goal) {
		const maxGoalCharacters = options.maxGoalCharacters ?? 240;
		lines.push(`Goal ${snapshot.goal.status} · ${snapshot.goal.objective.slice(0, maxGoalCharacters)}`);
	}
	if (snapshot.plan) {
		lines.push(`Plan v${snapshot.plan.version}`);
		for (const item of snapshot.plan.items.slice(0, options.maxPlanItems ?? 12))
			lines.push(`Plan ${item.status} · ${item.step}`);
	}
	if (snapshot.queues.pendingInputRequestId !== undefined)
		lines.push(`Input request pending · ${snapshot.queues.pendingInputRequestId}`);
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

function formatAgentDuration(startedAt: number): string {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
	return `${Math.floor(elapsedSeconds / 60)
		.toString()
		.padStart(2, "0")}:${(elapsedSeconds % 60).toString().padStart(2, "0")}`;
}

export function createRemoteV2StatuslinePayload(
	state: RemoteV2SessionState,
	options: RemoteV2StatuslinePayloadOptions,
): RemoteV2StatuslinePayload | undefined {
	const snapshot = state.snapshot;
	if (!snapshot) return undefined;
	const completed = snapshot.plan?.items.filter((item) => item.status === "completed").length ?? 0;
	const total = snapshot.plan?.items.length ?? 0;
	const active = snapshot.agents.filter(
		(agent) => agent.state === "running" || agent.state === "awaitingInput",
	).length;
	return {
		harness: "pi",
		session_id: snapshot.id,
		transcript_path: options.transcriptPath,
		cwd: options.cwd,
		...(snapshot.name === undefined ? {} : { session_name: snapshot.name }),
		model: { id: snapshot.model.id, display_name: snapshot.model.id, provider: snapshot.model.provider },
		effort: { level: snapshot.thinkingLevel },
		workspace: {
			current_dir: options.cwd,
			...(options.projectDir === undefined ? {} : { project_dir: options.projectDir }),
			added_dirs: [...(options.addedDirs ?? [])],
		},
		cost: {
			image_units: snapshot.usage.imageUnits ?? 0,
			...(snapshot.usage.costUsd === undefined ? {} : { total_cost_usd: snapshot.usage.costUsd }),
			pricing_state: snapshot.usage.pricingState,
		},
		context_window: {
			total_input_tokens: snapshot.usage.input,
			total_output_tokens: snapshot.usage.output,
			context_window_size: snapshot.context.contextWindow,
			used_percentage: snapshot.context.usedPercentage,
			remaining_percentage: Math.max(0, 100 - snapshot.context.usedPercentage),
		},
		task_indicator: { text: total === 0 ? "Tasks 0/0" : `Tasks ${completed}/${total}`, completed, total },
		...(snapshot.goal === undefined
			? {}
			: {
					goal: {
						status: snapshot.goal.status,
						...(snapshot.goal.tokenBudget === undefined
							? {}
							: { remaining_tokens: Math.max(0, snapshot.goal.tokenBudget - snapshot.goal.tokensUsed) }),
					},
				}),
		agents: { active, total: snapshot.agents.length },
		server: {
			connected: state.lifecycle.status !== "detached" && state.lifecycle.status !== "disposed",
			phase: snapshot.phase,
			detachable: state.lifecycle.status !== "disposed",
		},
	};
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
