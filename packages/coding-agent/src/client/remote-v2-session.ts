import type { PiClientV2, PiSessionV2Handle, V2SessionLeaseMode } from "@earendil-works/pi-client";
import type {
	CommandV2,
	JsonValue,
	ModelRef,
	EventEnvelopeV2 as ProtocolEvent,
	SessionSnapshotV2 as ProtocolSnapshot,
	ThinkingLevel as ProtocolThinkingLevel,
} from "@earendil-works/pi-protocol";

export type RemoteV2SessionLifecycle =
	| { readonly status: "unbound" }
	| { readonly status: "ready" }
	| { readonly status: "busy"; readonly operationId: string; readonly command: CommandV2["command"] }
	| { readonly status: "detached" }
	| { readonly status: "disposed" };

export interface RemoteV2SessionState {
	readonly lifecycle: RemoteV2SessionLifecycle;
	readonly snapshot?: ProtocolSnapshot;
	readonly lastEvent?: ProtocolEvent;
}

export interface RemoteV2SessionOptions {
	readonly onListenerError?: (error: Error) => void;
	readonly mode?: V2SessionLeaseMode;
}

type Listener = (state: RemoteV2SessionState) => void;

export class RemoteV2Session {
	readonly #client: PiClientV2;
	readonly #onListenerError: ((error: Error) => void) | undefined;
	readonly #mode: V2SessionLeaseMode;
	readonly #listeners = new Set<Listener>();
	#handle: PiSessionV2Handle | undefined;
	#unsubscribe: (() => void) | undefined;
	#snapshot: ProtocolSnapshot | undefined;
	#lastEvent: ProtocolEvent | undefined;
	#lifecycle: RemoteV2SessionLifecycle = { status: "unbound" };

	private constructor(client: PiClientV2, options: RemoteV2SessionOptions) {
		this.#client = client;
		this.#onListenerError = options.onListenerError;
		this.#mode = options.mode ?? "control";
	}

	static async open(
		client: PiClientV2,
		sessionId: string,
		options: RemoteV2SessionOptions = {},
	): Promise<RemoteV2Session> {
		const session = new RemoteV2Session(client, options);
		try {
			await session.attach(sessionId);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	get id(): string | undefined {
		return this.#handle?.sessionId;
	}
	get state(): RemoteV2SessionState {
		return { lifecycle: this.#lifecycle, snapshot: this.#snapshot, lastEvent: this.#lastEvent };
	}
	get snapshot(): ProtocolSnapshot | undefined {
		return this.#snapshot;
	}
	get phase(): ProtocolSnapshot["phase"] | undefined {
		return this.#snapshot?.phase;
	}
	get mode(): V2SessionLeaseMode | undefined {
		return this.#handle?.mode;
	}

	subscribe(listener: Listener): () => void {
		this.#assertNotDisposed();
		this.#listeners.add(listener);
		this.#notify(listener);
		return () => this.#listeners.delete(listener);
	}

	async attach(sessionId: string): Promise<void> {
		this.#assertNotDisposed();
		if (this.#handle?.sessionId === sessionId && this.#lifecycle.status === "ready") return;
		this.#unsubscribe?.();
		this.#handle = await this.#client.openSession(sessionId, this.#mode);
		this.#unsubscribe = this.#handle.onEvent((event) => this.#receiveEvent(event));
		await this.refresh();
		this.#lifecycle = { status: "ready" };
		this.#emit();
	}

	async refresh(): Promise<ProtocolSnapshot> {
		this.#assertNotDisposed();
		const handle = this.#requireHandle();
		const snapshot = await handle.read();
		if (this.#snapshot && snapshot.revision < this.#snapshot.revision) return this.#snapshot;
		this.#snapshot = structuredClone(snapshot);
		this.#emit();
		return this.#snapshot;
	}

	async submit(text: string): Promise<string> {
		const normalized = text.trim();
		if (!normalized) throw new Error("Session input cannot be empty");
		const command = this.phase === "turn" ? "turn/steer" : "turn/start";
		if (this.phase !== "idle" && this.phase !== "turn")
			throw new Error(`Session cannot accept input during ${this.phase ?? "unknown"} phase`);
		return this.#accept(command, { text: normalized });
	}

	async followUp(text: string): Promise<string> {
		const normalized = text.trim();
		if (!normalized) throw new Error("Session follow-up cannot be empty");
		return this.#accept("turn/followUp", { text: normalized });
	}

	async resume(): Promise<string> {
		return this.#accept("turn/resume");
	}

	async rollback(turns = 1): Promise<string> {
		if (!Number.isInteger(turns) || turns < 1) throw new Error("Rollback turns must be a positive integer");
		return this.#accept("turn/rollback", { turns });
	}

	async abort(): Promise<string> {
		return this.#accept("turn/abort");
	}

	async setModel(model: ModelRef): Promise<string> {
		return this.#accept("session/model/set", model);
	}
	async setThinking(thinkingLevel: ProtocolThinkingLevel): Promise<string> {
		return this.#accept("session/thinking/set", { level: thinkingLevel });
	}
	async createGoal(objective: string, tokenBudget?: number): Promise<string> {
		const normalized = objective.trim();
		if (!normalized) throw new Error("Goal objective cannot be empty");
		return this.#accept("goal/create", {
			objective: normalized,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		});
	}
	async pauseGoal(): Promise<string> {
		return this.#accept("goal/pause");
	}
	async resumeGoal(): Promise<string> {
		return this.#accept("goal/resume");
	}

	async relinquishControl(): Promise<void> {
		this.#assertNotDisposed();
		const handle = this.#requireHandle();
		await handle.relinquishControl();
		this.#emit();
	}

	async acquireControl(): Promise<void> {
		this.#assertNotDisposed();
		const handle = this.#requireHandle();
		await handle.acquireControl();
		this.#emit();
	}

	async detach(): Promise<void> {
		this.#assertNotDisposed();
		if (!this.#handle) return;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		await this.#handle.detach();
		this.#lifecycle = { status: "detached" };
		this.#emit();
	}

	async dispose(): Promise<void> {
		if (this.#lifecycle.status === "disposed") return;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.#handle && this.#lifecycle.status !== "detached") await this.#handle.detach();
		this.#handle = undefined;
		this.#lifecycle = { status: "disposed" };
		this.#emit();
		this.#listeners.clear();
	}

	#accept(command: CommandV2["command"], payload?: JsonValue): Promise<string> {
		this.#assertControl();
		const request = this.#client.request({
			command,
			sessionId: this.#handle!.sessionId,
			...(payload ? { payload } : {}),
		});
		return request.then((response) => {
			if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
			if (!("accepted" in response)) throw new Error("Expected an accepted operation response");
			this.#lifecycle = { status: "busy", operationId: response.accepted.operationId, command };
			this.#emit();
			return response.accepted.operationId;
		});
	}

	#receiveEvent(event: ProtocolEvent): void {
		this.#lastEvent = event;
		if (event.event === "operation_accepted") {
			const payload = asRecord(event.payload);
			if (event.operationId)
				this.#lifecycle = {
					status: "busy",
					operationId: event.operationId,
					command: this.#lifecycle.status === "busy" ? this.#lifecycle.command : "turn/start",
				};
			void payload;
		} else if (event.event === "operation_terminal") {
			const snapshot = asRecord(event.payload)?.snapshot;
			if (isSnapshot(snapshot)) this.#snapshot = structuredClone(snapshot);
			this.#lifecycle = { status: "ready" };
		}
		this.#emit();
	}

	#emit(): void {
		for (const listener of this.#listeners) this.#notify(listener);
	}
	#notify(listener: Listener): void {
		try {
			listener(this.state);
		} catch (error) {
			this.#onListenerError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}
	#requireHandle(): PiSessionV2Handle {
		if (!this.#handle) throw new Error("Session is not open");
		return this.#handle;
	}
	#assertControl(): void {
		this.#assertNotDisposed();
		if (this.#lifecycle.status === "detached" || !this.#handle) throw new Error("Session is not open");
		const handle = this.#requireHandle();
		if (handle.mode !== "control") throw new Error("Session requires a control lease");
	}
	#assertNotDisposed(): void {
		if (this.#lifecycle.status === "disposed") throw new Error("Remote v2 session is disposed");
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isSnapshot(value: unknown): value is ProtocolSnapshot {
	return (
		asRecord(value)?.id !== undefined &&
		asRecord(value)?.revision !== undefined &&
		asRecord(value)?.phase !== undefined
	);
}
