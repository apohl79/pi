import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { V2AgentRegistry } from "./agents.ts";
import type { V2AppRegistry } from "./apps.ts";
import type { V2BlobStore } from "./blobs.ts";
import type {
	DiagnosticContentStore,
	DiagnosticIntegrityProvider,
	DiagnosticRepairProvider,
	DiagnosticRuntimeManifest,
	ForensicRecorder,
} from "./diagnostics.ts";
import type { V2FileReferenceService } from "./files.ts";
import type { V2ImageService } from "./images.ts";
import type { V2InputRegistry } from "./inputs.ts";
import type { V2OperationStore } from "./operation-store.ts";
import type { V2PlanRegistry } from "./plans.ts";
import type { V2PluginRegistry } from "./plugins.ts";
import type { V2ProcessRegistry } from "./processes.ts";
import { createUnixServerV2 } from "./transports/unix/preset.ts";
import type { UnixServerOptions } from "./transports/unix/types.ts";
import type { V2UsageLedger } from "./usage-ledger.ts";
import type { PiServerServiceV2 } from "./v2.ts";
import type { V2WebService } from "./web.ts";

export type ServerDaemonState = "stopped" | "starting" | "running" | "stopping";

export interface ServerDaemonStatus {
	readonly state: ServerDaemonState;
	readonly serverId?: string;
	readonly addresses: readonly string[];
}

export interface ServerDaemonServer {
	readonly id: string;
	readonly addresses: readonly string[];
	start(): Promise<unknown>;
	close(): Promise<void>;
}

export interface ServerDaemonOptions {
	readonly service: PiServerServiceV2;
	readonly socketPath: string;
	readonly serverId?: string;
	readonly agents?: V2AgentRegistry;
	readonly inputs?: V2InputRegistry;
	readonly plans?: V2PlanRegistry;
	readonly processes?: V2ProcessRegistry;
	readonly web?: V2WebService;
	readonly images?: V2ImageService;
	readonly files?: V2FileReferenceService;
	readonly plugins?: V2PluginRegistry;
	readonly apps?: V2AppRegistry;
	readonly operationStore?: V2OperationStore;
	readonly blobs?: V2BlobStore;
	readonly diagnostics?: ForensicRecorder;
	readonly diagnosticContent?: DiagnosticContentStore;
	readonly integrity?: DiagnosticIntegrityProvider;
	readonly repairSafe?: DiagnosticRepairProvider;
	readonly runtimeManifest?: DiagnosticRuntimeManifest;
	readonly usage?: V2UsageLedger;
	/** Optional durable marker used to distinguish clean and unclean daemon generations. */
	readonly lifecycleMarkerPath?: string;
	readonly createServer?: (service: PiServerServiceV2, options: UnixServerOptions) => ServerDaemonServer;
}

interface DaemonLifecycleMarker {
	schemaVersion: 1;
	daemonInstanceId: string;
	state: "running" | "clean";
	timestamp: number;
}

/** Owns one restartable server instance and exposes a small daemon lifecycle seam. */
export class ServerDaemon {
	private state: ServerDaemonState = "stopped";
	private server?: ServerDaemonServer;
	private transition?: Promise<void>;
	private daemonInstanceId = "";
	private readonly options: ServerDaemonOptions;

	constructor(options: ServerDaemonOptions) {
		this.options = options;
	}

	status(): ServerDaemonStatus {
		const addresses = this.server === undefined ? [] : [...this.server.addresses];
		return {
			state: this.state,
			...(this.server === undefined ? {} : { serverId: this.server.id }),
			addresses,
		};
	}

	async start(): Promise<ServerDaemonStatus> {
		if (this.state === "running") return this.status();
		if (this.transition) {
			await this.transition;
			return this.status();
		}
		if (this.state !== "stopped") throw new Error(`Cannot start daemon while it is ${this.state}`);
		this.state = "starting";
		this.transition = this.startInternal();
		try {
			await this.transition;
			return this.status();
		} finally {
			this.transition = undefined;
		}
	}

	async stop(): Promise<ServerDaemonStatus> {
		if (this.state === "stopped") return this.status();
		if (this.transition) {
			await this.transition;
			return this.stop();
		}
		if (this.state !== "running" || this.server === undefined)
			throw new Error(`Cannot stop daemon while it is ${this.state}`);
		this.state = "stopping";
		this.transition = this.stopInternal(this.server);
		try {
			await this.transition;
			return this.status();
		} finally {
			this.transition = undefined;
		}
	}

	private async startInternal(): Promise<void> {
		this.daemonInstanceId = randomUUID();
		const previousMarker = await this.readLifecycleMarker();
		if (previousMarker?.state === "running") {
			const lostProcesses = (await this.options.processes?.markLost()) ?? 0;
			await this.recordDiagnostic(
				"daemon_unclean_shutdown",
				{ previousDaemonInstanceId: previousMarker.daemonInstanceId, lostProcesses },
				"error",
				"error",
			);
		}
		await this.writeLifecycleMarker("running");
		await this.recordDiagnostic("daemon_starting", { socketPath: this.options.socketPath }, "started");
		let server: ServerDaemonServer;
		try {
			server = (this.options.createServer ?? defaultCreateServer)(this.options.service, {
				path: this.options.socketPath,
				...(this.options.serverId === undefined ? {} : { serverId: this.options.serverId }),
				daemonInstanceId: this.daemonInstanceId,
				...(this.options.agents === undefined ? {} : { agents: this.options.agents }),
				...(this.options.inputs === undefined ? {} : { inputs: this.options.inputs }),
				...(this.options.plans === undefined ? {} : { plans: this.options.plans }),
				...(this.options.processes === undefined ? {} : { processes: this.options.processes }),
				...(this.options.web === undefined ? {} : { web: this.options.web }),
				...(this.options.images === undefined ? {} : { images: this.options.images }),
				...(this.options.files === undefined ? {} : { files: this.options.files }),
				...(this.options.plugins === undefined ? {} : { plugins: this.options.plugins }),
				...(this.options.apps === undefined ? {} : { apps: this.options.apps }),
				...(this.options.operationStore === undefined ? {} : { operationStore: this.options.operationStore }),
				...(this.options.blobs === undefined ? {} : { blobs: this.options.blobs }),
				...(this.options.diagnostics === undefined ? {} : { diagnostics: this.options.diagnostics }),
				...(this.options.diagnosticContent === undefined
					? {}
					: { diagnosticContent: this.options.diagnosticContent }),
				...(this.options.integrity === undefined ? {} : { integrity: this.options.integrity }),
				...(this.options.repairSafe === undefined ? {} : { repairSafe: this.options.repairSafe }),
				...(this.options.runtimeManifest === undefined ? {} : { runtimeManifest: this.options.runtimeManifest }),
				...(this.options.usage === undefined ? {} : { usage: this.options.usage }),
			});
		} catch (error) {
			await this.writeLifecycleMarker("clean").catch(() => {});
			this.state = "stopped";
			await this.recordDiagnostic(
				"daemon_start_failed",
				{ error: error instanceof Error ? error.message : String(error) },
				"error",
				"error",
			);
			throw error;
		}
		try {
			await server.start();
		} catch (error) {
			await server.close().catch(() => {});
			await this.writeLifecycleMarker("clean").catch(() => {});
			this.state = "stopped";
			await this.recordDiagnostic(
				"daemon_start_failed",
				{ error: error instanceof Error ? error.message : String(error) },
				"error",
				"error",
			);
			throw error;
		}
		this.server = server;
		this.state = "running";
		await this.recordDiagnostic("daemon_started", { serverId: server.id, addresses: server.addresses }, "ok");
	}

	private async stopInternal(server: ServerDaemonServer): Promise<void> {
		const lostProcesses = (await this.options.processes?.markLost()) ?? 0;
		await this.recordDiagnostic("daemon_stopping", { serverId: server.id, lostProcesses }, "started");
		try {
			await server.close();
		} finally {
			await this.writeLifecycleMarker("clean");
			this.server = undefined;
			this.state = "stopped";
			await this.recordDiagnostic("daemon_stopped", { serverId: server.id }, "ok");
		}
	}

	private async readLifecycleMarker(): Promise<DaemonLifecycleMarker | undefined> {
		if (this.options.lifecycleMarkerPath === undefined) return undefined;
		try {
			const value = JSON.parse(
				await readFile(this.options.lifecycleMarkerPath, "utf8"),
			) as Partial<DaemonLifecycleMarker>;
			if (
				value.schemaVersion !== 1 ||
				typeof value.daemonInstanceId !== "string" ||
				(value.state !== "running" && value.state !== "clean") ||
				!Number.isSafeInteger(value.timestamp)
			) {
				await this.recordDiagnostic("daemon_lifecycle_marker_invalid", { reason: "schema" }, "error", "error");
				return undefined;
			}
			return value as DaemonLifecycleMarker;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			await this.recordDiagnostic(
				"daemon_lifecycle_marker_invalid",
				{ reason: error instanceof SyntaxError ? "json" : "read" },
				"error",
				"error",
			);
			return undefined;
		}
	}

	private async writeLifecycleMarker(state: DaemonLifecycleMarker["state"]): Promise<void> {
		if (this.options.lifecycleMarkerPath === undefined) return;
		const path = this.options.lifecycleMarkerPath;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ schemaVersion: 1, daemonInstanceId: this.daemonInstanceId, state, timestamp: Date.now() })}\n`,
			{ mode: 0o600 },
		);
		await rename(temporary, path);
	}

	private async recordDiagnostic(
		kind: string,
		payload: Record<string, unknown>,
		outcome: "started" | "ok" | "error",
		severity: "debug" | "info" | "warn" | "error" = "info",
	): Promise<void> {
		await this.options.diagnostics
			?.record({ kind, payload, outcome, severity, daemonInstanceId: this.daemonInstanceId })
			.catch(() => {});
	}
}

function defaultCreateServer(service: PiServerServiceV2, options: UnixServerOptions): ServerDaemonServer {
	return createUnixServerV2(service, options);
}
