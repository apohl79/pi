import type {
	CreateSessionV2Options,
	PiClientV2,
	PiSessionV2Handle,
	V2SessionLeaseMode,
} from "@earendil-works/pi-client";
import type {
	AgentSummary,
	CommandV2,
	JsonValue,
	ModelRef,
	PlanItem,
	PlanSnapshot,
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

export type RemoteV2PromptPart =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly digest: string; readonly mimeType: string }
	| { readonly type: "blob"; readonly digest: string; readonly mimeType: string }
	| { readonly type: "mention"; readonly name: string; readonly path: string };

export type RemoteV2PromptContent = readonly RemoteV2PromptPart[];

export interface RemoteV2SpawnAgentOptions {
	readonly role?: string;
	readonly model?: ModelRef;
	readonly parentPath?: string;
}

export interface RemoteV2ProcessOutput {
	readonly output: string;
	readonly cursor: number;
	readonly truncated: boolean;
}

export interface RemoteV2ProcessSnapshot extends RemoteV2ProcessOutput {
	readonly processId: string;
	readonly sessionId: string;
	readonly command: string;
	readonly pty: boolean;
	readonly state: "running" | "exited" | "terminated" | "lost";
	readonly exitCode?: number;
}

export interface RemoteV2FileReference {
	readonly reference: string;
	readonly path: string;
	readonly kind: "file" | "directory";
	readonly size?: number;
	readonly mimeType?: string;
}

export interface RemoteV2FileCompletion {
	readonly reference: string;
	readonly path: string;
	readonly kind: "file" | "directory";
}

export interface RemoteV2FileRead {
	readonly file: RemoteV2FileReference;
	readonly encoding: "base64";
	readonly data: string;
}

export interface RemoteV2BlobStat {
	readonly digest: string;
	readonly mimeType: string;
	readonly size: number;
}

export interface RemoteV2BlobRead {
	readonly digest: string;
	readonly encoding: "base64";
	readonly data: string;
}

export interface RemoteV2DiagnosticsStatus {
	readonly capture: "metadata" | "encrypted";
	readonly degraded: boolean;
	readonly lastCriticalEventSeq: number;
	readonly eventCount: number;
}

export interface RemoteV2UsageRead {
	readonly aggregate: Record<string, unknown>;
	readonly entries: readonly Record<string, unknown>[];
}

export interface RemoteV2PluginInstallOptions {
	readonly name: string;
	readonly marketplace: string;
	readonly version: string;
	readonly manifest: Record<string, unknown>;
	readonly root?: string;
	readonly scope?: "user" | "project";
}

export interface RemoteV2AppAuthOptions extends Record<string, unknown> {
	readonly id: string;
}

export interface RemoteV2WebResult {
	readonly id: string;
	readonly url?: string;
	readonly title: string;
	readonly source: string;
	readonly retrievedAt: number;
	readonly extract?: string;
	readonly mimeType?: string;
	readonly blobDigest?: string;
}

export interface RemoteV2ImageView {
	readonly digest: string;
	readonly mimeType: string;
	readonly size: number;
	readonly reference: string;
}

export interface RemoteV2GeneratedImage extends RemoteV2ImageView {
	readonly provider: string;
	readonly model: string;
	readonly dimensions?: Readonly<{ width: number; height: number }>;
	readonly promptHash: string;
	readonly costUsd?: number;
}

function promptPayload(input: string | RemoteV2PromptContent, label: string): JsonValue {
	if (typeof input === "string") {
		const text = input.trim();
		if (!text) throw new Error(`${label} cannot be empty`);
		return { text };
	}
	if (input.length === 0) throw new Error(`${label} cannot be empty`);
	const content: JsonValue[] = input.map((part): JsonValue => {
		if (part.type === "text") return { type: "text", text: part.text } as JsonValue;
		if (part.type === "mention") return { type: "mention", name: part.name, path: part.path } as JsonValue;
		return { type: part.type, digest: part.digest, mimeType: part.mimeType } as JsonValue;
	});
	return {
		content,
	};
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

	static async create(
		client: PiClientV2,
		options: CreateSessionV2Options = {},
		sessionOptions: RemoteV2SessionOptions = {},
	): Promise<RemoteV2Session> {
		const created = await client.createSession(options);
		return RemoteV2Session.open(client, created.id, sessionOptions);
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

	async submit(input: string | RemoteV2PromptContent): Promise<string> {
		const payload = promptPayload(input, "Session input");
		const command = this.phase === "turn" ? "turn/steer" : "turn/start";
		if (this.phase !== "idle" && this.phase !== "turn")
			throw new Error(`Session cannot accept input during ${this.phase ?? "unknown"} phase`);
		return this.#accept(command, payload);
	}

	async waitForOperation(operationId: string): Promise<ProtocolSnapshot> {
		this.#assertNotDisposed();
		if (this.#lifecycle.status === "ready" && this.#lastEvent?.operationId === operationId && this.#snapshot)
			return structuredClone(this.#snapshot);
		return new Promise<ProtocolSnapshot>((resolve) => {
			let unsubscribe = () => {};
			unsubscribe = this.subscribe((state) => {
				if (
					state.lifecycle.status !== "ready" ||
					state.lastEvent?.operationId !== operationId ||
					state.snapshot === undefined
				)
					return;
				unsubscribe();
				resolve(structuredClone(state.snapshot));
			});
		});
	}

	async followUp(input: string | RemoteV2PromptContent): Promise<string> {
		return this.#accept("turn/followUp", promptPayload(input, "Session follow-up"));
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

	async respondInput(requestId: string, answers: Readonly<Record<string, string>>): Promise<void> {
		this.#assertControl();
		const response = await this.#client.request({
			command: "input/request/respond",
			sessionId: this.#handle!.sessionId,
			payload: { requestId, answers: { ...answers } },
		});
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	}

	async cancelInput(requestId: string): Promise<void> {
		this.#assertControl();
		const response = await this.#client.request({
			command: "input/request/cancel",
			sessionId: this.#handle!.sessionId,
			payload: { requestId },
		});
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	}

	async updatePlan(items: readonly PlanItem[], version?: number): Promise<PlanSnapshot> {
		this.#assertControl();
		const response = await this.#client.request({
			command: "plan/update",
			sessionId: this.#handle!.sessionId,
			payload: { items: items.map((item) => ({ ...item })), ...(version === undefined ? {} : { version }) },
		});
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		if (!("result" in response)) throw new Error("Invalid plan/update response");
		const plan = asRecord(response.result)?.plan;
		if (!isPlanSnapshot(plan)) throw new Error("Invalid plan/update response");
		return structuredClone(plan);
	}

	async clearPlan(): Promise<void> {
		this.#assertControl();
		const response = await this.#client.request({ command: "plan/clear", sessionId: this.#handle!.sessionId });
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	}

	async listAgents(): Promise<readonly AgentSummary[]> {
		const result = await this.#direct({ command: "agent/list", sessionId: this.#handle!.sessionId });
		if (!Array.isArray(result.agents) || !result.agents.every(isAgentSummary))
			throw new Error("Invalid agent/list response");
		return result.agents.map((agent) => structuredClone(agent));
	}

	async spawnAgent(
		taskName: string,
		taskMessage: string,
		options: RemoteV2SpawnAgentOptions = {},
	): Promise<AgentSummary> {
		this.#assertControl();
		const result = await this.#direct({
			command: "agent/spawn",
			sessionId: this.#handle!.sessionId,
			payload: {
				taskName,
				taskMessage,
				...(options.role === undefined ? {} : { role: options.role }),
				...(options.parentPath === undefined ? {} : { parentPath: options.parentPath }),
				...(options.model === undefined ? {} : { model: options.model }),
			},
		});
		if (!isAgentSummary(result.agent)) throw new Error("Invalid agent/spawn response");
		return structuredClone(result.agent);
	}

	async messageAgent(agentId: string, message: string): Promise<void> {
		this.#assertControl();
		await this.#direct({
			command: "agent/message",
			sessionId: this.#handle!.sessionId,
			payload: { agentId, message },
		});
	}

	async followUpAgent(agentId: string, message: string): Promise<AgentSummary> {
		this.#assertControl();
		const result = await this.#direct({
			command: "agent/followUp",
			sessionId: this.#handle!.sessionId,
			payload: { agentId, message },
		});
		if (!isAgentSummary(result.agent)) throw new Error("Invalid agent/followUp response");
		return structuredClone(result.agent);
	}

	async interruptAgent(agentId: string): Promise<AgentSummary> {
		this.#assertControl();
		const result = await this.#direct({
			command: "agent/interrupt",
			sessionId: this.#handle!.sessionId,
			payload: { agentId },
		});
		if (!isAgentSummary(result.agent)) throw new Error("Invalid agent/interrupt response");
		return structuredClone(result.agent);
	}

	async startProcess(
		command: string,
		options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly pty?: boolean } = {},
	): Promise<RemoteV2ProcessSnapshot> {
		this.#assertControl();
		const result = await this.#direct({
			command: "process/start",
			sessionId: this.#handle!.sessionId,
			payload: {
				command,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.env === undefined ? {} : { env: { ...options.env } }),
				...(options.pty === undefined ? {} : { pty: options.pty }),
			},
		});
		if (!isProcessSnapshot(result.process)) throw new Error("Invalid process/start response");
		return structuredClone(result.process);
	}

	async writeProcess(processId: string, input: string): Promise<RemoteV2ProcessOutput> {
		this.#assertControl();
		const result = await this.#direct({
			command: "process/write",
			sessionId: this.#handle!.sessionId,
			payload: { processId, input },
		});
		if (!isProcessOutput(result.output)) throw new Error("Invalid process/write response");
		return structuredClone(result.output);
	}

	async readProcess(processId: string, cursor = 0): Promise<RemoteV2ProcessOutput> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "process/read",
			sessionId: this.#requireHandle().sessionId,
			payload: { processId, cursor },
		});
		if (!isProcessOutput(result.output)) throw new Error("Invalid process/read response");
		return structuredClone(result.output);
	}

	async waitProcess(processId: string): Promise<RemoteV2ProcessSnapshot> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "process/wait",
			sessionId: this.#requireHandle().sessionId,
			payload: { processId },
		});
		if (!isProcessSnapshot(result.process)) throw new Error("Invalid process/wait response");
		return structuredClone(result.process);
	}

	async terminateProcess(processId: string): Promise<RemoteV2ProcessSnapshot> {
		this.#assertControl();
		const result = await this.#direct({
			command: "process/terminate",
			sessionId: this.#handle!.sessionId,
			payload: { processId },
		});
		if (!isProcessSnapshot(result.process)) throw new Error("Invalid process/terminate response");
		return structuredClone(result.process);
	}

	async completeFiles(prefix: string): Promise<readonly RemoteV2FileCompletion[]> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "filesystem/complete",
			sessionId: this.#requireHandle().sessionId,
			payload: { prefix },
		});
		if (!Array.isArray(result.items) || !result.items.every(isFileCompletion))
			throw new Error("Invalid filesystem/complete response");
		return result.items.map((item) => structuredClone(item));
	}

	async resolveFile(reference: string): Promise<RemoteV2FileReference> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "filesystem/reference/resolve",
			sessionId: this.#requireHandle().sessionId,
			payload: { reference },
		});
		if (!isFileReference(result.file)) throw new Error("Invalid filesystem/reference/resolve response");
		return structuredClone(result.file);
	}

	async readFile(reference: string): Promise<RemoteV2FileRead> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "filesystem/reference/read",
			sessionId: this.#requireHandle().sessionId,
			payload: { reference },
		});
		if (!isFileReference(result.file) || result.encoding !== "base64" || typeof result.data !== "string")
			throw new Error("Invalid filesystem/reference/read response");
		return { file: structuredClone(result.file), encoding: "base64", data: result.data };
	}

	async putBlob(data: string, mimeType: string, encoding: "utf8" | "base64" = "base64"): Promise<RemoteV2BlobStat> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "blob/put", payload: { data, mimeType, encoding } });
		if (!isBlobStat(result.blob)) throw new Error("Invalid blob/put response");
		return structuredClone(result.blob);
	}

	async readBlob(digest: string): Promise<RemoteV2BlobRead> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "blob/read", payload: { digest } });
		if (result.digest !== digest || result.encoding !== "base64" || typeof result.data !== "string")
			throw new Error("Invalid blob/read response");
		return { digest, encoding: "base64", data: result.data };
	}

	async statBlob(digest: string): Promise<RemoteV2BlobStat> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "blob/stat", payload: { digest } });
		if (!isBlobStat(result.blob) || result.blob.digest !== digest) throw new Error("Invalid blob/stat response");
		return structuredClone(result.blob);
	}

	async listMarketplaces(): Promise<readonly Record<string, unknown>[]> {
		const result = await this.#direct({ command: "marketplace/list" });
		return records(result.marketplaces, "marketplace/list");
	}

	async addMarketplace(name: string, source: string): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "marketplace/add", payload: { name, source } });
		return record(result.marketplace, "marketplace/add");
	}

	async upgradeMarketplace(name: string): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "marketplace/upgrade", payload: { name } });
		return record(result.marketplace, "marketplace/upgrade");
	}

	async removeMarketplace(name: string): Promise<void> {
		await this.#direct({ command: "marketplace/remove", payload: { name } });
	}

	async listPlugins(installedOnly = false): Promise<readonly Record<string, unknown>[]> {
		const result = await this.#direct({ command: "plugin/list", payload: { installedOnly } });
		return records(result.plugins, "plugin/list");
	}

	async readPlugin(id: string): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "plugin/read", payload: { id } });
		return record(result.plugin, "plugin/read");
	}

	async installPlugin(options: RemoteV2PluginInstallOptions): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "plugin/install", payload: options as unknown as JsonValue });
		return record(result.plugin, "plugin/install");
	}

	async uninstallPlugin(id: string): Promise<void> {
		await this.#direct({ command: "plugin/uninstall", payload: { id } });
	}

	async setPluginEnabled(id: string, enabled: boolean, scope?: "user" | "project"): Promise<Record<string, unknown>> {
		const result = await this.#direct({
			command: enabled ? "plugin/enable" : "plugin/disable",
			payload: { id, ...(scope === undefined ? {} : { scope }) },
		});
		return record(result.plugin, enabled ? "plugin/enable" : "plugin/disable");
	}

	async listApps(): Promise<readonly Record<string, unknown>[]> {
		const result = await this.#direct({ command: "app/list" });
		return records(result.apps, "app/list");
	}

	async readApp(id: string): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "app/read", payload: { id } });
		return record(result.app, "app/read");
	}

	async startAppAuth(options: RemoteV2AppAuthOptions): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "app/auth/start", payload: options as unknown as JsonValue });
		return record(result.auth, "app/auth/start");
	}

	async completeAppAuth(options: RemoteV2AppAuthOptions): Promise<Record<string, unknown>> {
		const result = await this.#direct({ command: "app/auth/complete", payload: options as unknown as JsonValue });
		return record(result.auth, "app/auth/complete");
	}

	async readUsage(filter: Record<string, string> = {}): Promise<RemoteV2UsageRead> {
		const result = await this.#direct({ command: "usage/read", payload: filter as unknown as JsonValue });
		return {
			aggregate: record(result.aggregate, "usage/read"),
			entries: records(result.entries, "usage/read"),
		};
	}

	async diagnosticsStatus(): Promise<RemoteV2DiagnosticsStatus> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "diagnostics/status" });
		if (
			(result.capture !== "metadata" && result.capture !== "encrypted") ||
			typeof result.degraded !== "boolean" ||
			typeof result.lastCriticalEventSeq !== "number" ||
			typeof result.eventCount !== "number"
		)
			throw new Error("Invalid diagnostics/status response");
		return {
			capture: result.capture,
			degraded: result.degraded,
			lastCriticalEventSeq: result.lastCriticalEventSeq,
			eventCount: result.eventCount,
		};
	}

	async diagnosticsTimeline(
		options: { readonly afterSeq?: number; readonly sessionId?: string; readonly operationId?: string } = {},
	): Promise<readonly Record<string, unknown>[]> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "diagnostics/timeline", payload: options });
		if (!Array.isArray(result.events) || !result.events.every((event) => asRecord(event) !== undefined))
			throw new Error("Invalid diagnostics/timeline response");
		return result.events.map((event) => structuredClone(asRecord(event)!));
	}

	async diagnosticsExport(decryptContent = false): Promise<Record<string, unknown>> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "diagnostics/export", payload: { decryptContent } });
		const bundle = asRecord(result.bundle);
		if (bundle === undefined || asRecord(bundle.manifest) === undefined)
			throw new Error("Invalid diagnostics/export response");
		return structuredClone(bundle);
	}

	async diagnosticsVerify(bundle?: Record<string, unknown>): Promise<Record<string, unknown>> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "diagnostics/verify",
			...(bundle ? { payload: { bundle: bundle as JsonValue } } : {}),
		});
		if (typeof result.valid !== "boolean") throw new Error("Invalid diagnostics/verify response");
		return structuredClone(result);
	}

	async diagnosticsDoctor(repairSafe = false): Promise<Record<string, unknown>> {
		this.#assertNotDisposed();
		const result = await this.#direct({ command: "diagnostics/doctor", payload: { repairSafe } });
		if (typeof result.ok !== "boolean" || !Array.isArray(result.checks))
			throw new Error("Invalid diagnostics/doctor response");
		return structuredClone(result);
	}

	async webRequest(
		operation: "search_query" | "open" | "click" | "find" | "screenshot" | "image_query",
		options: {
			readonly query?: string;
			readonly url?: string;
			readonly refId?: string;
			readonly pattern?: string;
		} = {},
	): Promise<readonly RemoteV2WebResult[]> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "web",
			sessionId: this.#requireHandle().sessionId,
			payload: { operation, ...options },
		});
		if (!Array.isArray(result.results) || !result.results.every(isWebResult)) throw new Error("Invalid web response");
		return result.results.map((item) => structuredClone(item));
	}

	async viewImage(reference: string): Promise<RemoteV2ImageView> {
		this.#assertNotDisposed();
		const result = await this.#direct({
			command: "image/view",
			sessionId: this.#requireHandle().sessionId,
			payload: { reference },
		});
		if (!isImageView(result.image)) throw new Error("Invalid image/view response");
		return structuredClone(result.image);
	}

	async generateImage(prompt: string, sourceDigest?: string): Promise<RemoteV2GeneratedImage> {
		this.#assertControl();
		const result = await this.#direct({
			command: "image/generate",
			sessionId: this.#handle!.sessionId,
			payload: { prompt, ...(sourceDigest === undefined ? {} : { sourceDigest }) },
		});
		if (!isGeneratedImage(result.image)) throw new Error("Invalid image/generate response");
		return structuredClone(result.image);
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
			const terminalAlreadyObserved =
				this.#lastEvent?.event === "operation_terminal" &&
				this.#lastEvent.operationId === response.accepted.operationId;
			this.#lifecycle = terminalAlreadyObserved
				? { status: "ready" }
				: { status: "busy", operationId: response.accepted.operationId, command };
			this.#emit();
			return response.accepted.operationId;
		});
	}

	async #direct(command: CommandV2): Promise<Record<string, unknown>> {
		const response = await this.#client.request(command);
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		if (!("result" in response)) throw new Error(`Invalid ${command.command} response`);
		const result = asRecord(response.result);
		if (result === undefined) throw new Error(`Invalid ${command.command} response`);
		return result;
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
		} else if (event.event === "plan_updated" && this.#snapshot) {
			const plan = asRecord(event.payload)?.plan;
			if (plan === null) {
				const { plan: _plan, ...snapshot } = this.#snapshot;
				this.#snapshot = snapshot;
			} else if (isPlanSnapshot(plan)) {
				this.#snapshot = { ...this.#snapshot, plan: structuredClone(plan) };
			}
		} else if (event.event === "agent_updated" && this.#snapshot) {
			const agent = asRecord(event.payload)?.agent;
			if (isAgentSummary(agent)) {
				const current = this.#snapshot.agents.filter((item) => item.id !== agent.id);
				this.#snapshot = { ...this.#snapshot, agents: [...current, structuredClone(agent)] };
			}
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

function record(value: unknown, command: string): Record<string, unknown> {
	const result = asRecord(value);
	if (result === undefined) throw new Error(`Invalid ${command} response`);
	return structuredClone(result);
}

function records(value: unknown, command: string): readonly Record<string, unknown>[] {
	if (!Array.isArray(value) || !value.every((entry) => asRecord(entry) !== undefined))
		throw new Error(`Invalid ${command} response`);
	return value.map((entry) => structuredClone(asRecord(entry)!));
}

function isSnapshot(value: unknown): value is ProtocolSnapshot {
	return (
		asRecord(value)?.id !== undefined &&
		asRecord(value)?.revision !== undefined &&
		asRecord(value)?.phase !== undefined
	);
}

function isPlanSnapshot(value: unknown): value is PlanSnapshot {
	const record = asRecord(value);
	return (
		record?.version !== undefined &&
		typeof record.version === "number" &&
		Array.isArray(record.items) &&
		record.items.every((item) => {
			const entry = asRecord(item);
			return (
				typeof entry?.step === "string" &&
				(entry.status === "pending" || entry.status === "in_progress" || entry.status === "completed")
			);
		})
	);
}

function isAgentSummary(value: unknown): value is AgentSummary {
	const record = asRecord(value);
	const model = asRecord(record?.model);
	return (
		typeof record?.id === "string" &&
		typeof record.path === "string" &&
		typeof record.taskName === "string" &&
		["idle", "running", "awaitingInput", "complete", "failed", "interrupted"].includes(record.state as string) &&
		typeof model?.provider === "string" &&
		typeof model.id === "string"
	);
}

function isProcessOutput(value: unknown): value is RemoteV2ProcessOutput {
	const record = asRecord(value);
	return (
		typeof record?.output === "string" && typeof record.cursor === "number" && typeof record.truncated === "boolean"
	);
}

function isProcessSnapshot(value: unknown): value is RemoteV2ProcessSnapshot {
	const record = asRecord(value);
	return (
		isProcessOutput(value) &&
		typeof record?.processId === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.command === "string" &&
		typeof record.pty === "boolean" &&
		["running", "exited", "terminated", "lost"].includes(record.state as string) &&
		(record.exitCode === undefined || typeof record.exitCode === "number")
	);
}

function isFileReference(value: unknown): value is RemoteV2FileReference {
	const record = asRecord(value);
	return (
		typeof record?.reference === "string" &&
		typeof record.path === "string" &&
		(record.kind === "file" || record.kind === "directory") &&
		(record.size === undefined || typeof record.size === "number") &&
		(record.mimeType === undefined || typeof record.mimeType === "string")
	);
}

function isFileCompletion(value: unknown): value is RemoteV2FileCompletion {
	const record = asRecord(value);
	return (
		typeof record?.reference === "string" &&
		typeof record.path === "string" &&
		(record.kind === "file" || record.kind === "directory")
	);
}

function isBlobStat(value: unknown): value is RemoteV2BlobStat {
	const record = asRecord(value);
	return typeof record?.digest === "string" && typeof record.mimeType === "string" && typeof record.size === "number";
}

function isWebResult(value: unknown): value is RemoteV2WebResult {
	const record = asRecord(value);
	return (
		typeof record?.id === "string" &&
		typeof record.title === "string" &&
		typeof record.source === "string" &&
		typeof record.retrievedAt === "number" &&
		(record.url === undefined || typeof record.url === "string") &&
		(record.extract === undefined || typeof record.extract === "string") &&
		(record.mimeType === undefined || typeof record.mimeType === "string") &&
		(record.blobDigest === undefined || typeof record.blobDigest === "string")
	);
}

function isImageView(value: unknown): value is RemoteV2ImageView {
	const record = asRecord(value);
	return (
		typeof record?.digest === "string" &&
		typeof record.mimeType === "string" &&
		typeof record.size === "number" &&
		typeof record.reference === "string"
	);
}

function isGeneratedImage(value: unknown): value is RemoteV2GeneratedImage {
	const record = asRecord(value);
	const dimensions = asRecord(record?.dimensions);
	return (
		isImageView(value) &&
		typeof record?.provider === "string" &&
		typeof record.model === "string" &&
		typeof record.promptHash === "string" &&
		(record.costUsd === undefined || typeof record.costUsd === "number") &&
		(dimensions === undefined || (typeof dimensions.width === "number" && typeof dimensions.height === "number"))
	);
}
