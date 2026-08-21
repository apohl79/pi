import type { V2AgentRegistry } from "./agents.ts";
import { createUnixServerV2 } from "./transports/unix/preset.ts";
import type { UnixServerOptions } from "./transports/unix/types.ts";
import type { PiServerServiceV2 } from "./v2.ts";

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
		let server: ServerDaemonServer | undefined;
		try {
			server = (this.options.createServer ?? defaultCreateServer)(this.options.service, {
				path: this.options.socketPath,
				...(this.options.serverId === undefined ? {} : { serverId: this.options.serverId }),
				...(this.options.agents === undefined ? {} : { agents: this.options.agents }),
			});
			await server.start();
			this.server = server;
			this.state = "running";
		} catch (error) {
			await server?.close().catch(() => {});
			this.server = undefined;
			this.state = "stopped";
			throw error;
		}
	}

	private async stopInternal(server: ServerDaemonServer): Promise<void> {
		try {
			await server.close();
		} finally {
			this.server = undefined;
			this.state = "stopped";
		}
	}
}

function defaultCreateServer(service: PiServerServiceV2, options: UnixServerOptions): ServerDaemonServer {
	return createUnixServerV2(service, options);
}
