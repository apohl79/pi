import type { V2AgentRegistry } from "./agents.ts";
import type { DiagnosticContentStore, ForensicRecorder } from "./diagnostics.ts";
import type { V2ImageService } from "./images.ts";
import type { V2InputRegistry } from "./inputs.ts";
import type { V2PlanRegistry } from "./plans.ts";
import type { V2ProcessRegistry } from "./processes.ts";
import { createUnixServerV2 } from "./transports/unix/preset.ts";
import type { UnixServerOptions } from "./transports/unix/types.ts";
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
	readonly diagnostics?: ForensicRecorder;
	readonly diagnosticContent?: DiagnosticContentStore;
	readonly createServer?: (service: PiServerServiceV2, options: UnixServerOptions) => ServerDaemonServer;
}

/** Owns one restartable server instance and exposes a small daemon lifecycle seam. */
export class ServerDaemon {
	private state: ServerDaemonState = "stopped";
	private server?: ServerDaemonServer;
	private transition?: Promise<void>;
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
		await this.recordDiagnostic("daemon_starting", { socketPath: this.options.socketPath });
		let server: ServerDaemonServer;
		try {
			server = (this.options.createServer ?? defaultCreateServer)(this.options.service, {
				path: this.options.socketPath,
				...(this.options.serverId === undefined ? {} : { serverId: this.options.serverId }),
				...(this.options.agents === undefined ? {} : { agents: this.options.agents }),
				...(this.options.inputs === undefined ? {} : { inputs: this.options.inputs }),
				...(this.options.plans === undefined ? {} : { plans: this.options.plans }),
				...(this.options.processes === undefined ? {} : { processes: this.options.processes }),
				...(this.options.web === undefined ? {} : { web: this.options.web }),
				...(this.options.images === undefined ? {} : { images: this.options.images }),
				...(this.options.diagnostics === undefined ? {} : { diagnostics: this.options.diagnostics }),
				...(this.options.diagnosticContent === undefined
					? {}
					: { diagnosticContent: this.options.diagnosticContent }),
			});
		} catch (error) {
			this.state = "stopped";
			throw error;
		}
		try {
			await server.start();
		} catch (error) {
			await server.close().catch(() => {});
			this.state = "stopped";
			await this.recordDiagnostic("daemon_start_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		this.server = server;
		this.state = "running";
		await this.recordDiagnostic("daemon_started", { serverId: server.id, addresses: server.addresses });
	}

	private async stopInternal(server: ServerDaemonServer): Promise<void> {
		await this.recordDiagnostic("daemon_stopping", { serverId: server.id });
		try {
			await server.close();
		} finally {
			this.server = undefined;
			this.state = "stopped";
			await this.recordDiagnostic("daemon_stopped", { serverId: server.id });
		}
	}

	private async recordDiagnostic(kind: string, payload: Record<string, unknown>): Promise<void> {
		await this.options.diagnostics?.record({ kind, payload }).catch(() => {});
	}
}

function defaultCreateServer(service: PiServerServiceV2, options: UnixServerOptions): ServerDaemonServer {
	return createUnixServerV2(service, options);
}
