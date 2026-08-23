import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { ServerDaemon, type ServerDaemonOptions } from "@earendil-works/pi-server";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import {
	createExperimentalCliRuntime,
	type ExperimentalCliRuntime,
	type ExperimentalCliRuntimeOptions,
} from "../cli/experimental/runtime.ts";
import type { TransportAddress } from "../cli/experimental/transport-address.ts";
import { createCodingAgentV2AgentRegistry } from "./agent-registry.ts";
import { type CodingAgentV2SqliteServiceOptions, createCodingAgentV2SqliteService } from "./sqlite-service.ts";

export type CodingAgentDaemonRuntimeOptions = Omit<CodingAgentV2SqliteServiceOptions, "repository"> & {
	repository: SqliteSessionRepository;
	socketPath: string;
	serverId?: string;
	agents?: ServerDaemonOptions["agents"];
	createServer?: ServerDaemonOptions["createServer"];
	write(value: unknown): void;
	onAttach?: ExperimentalCliRuntimeOptions["onAttach"];
};

export type CodingAgentDaemonRuntime = {
	readonly service: Awaited<ReturnType<typeof createCodingAgentV2SqliteService>>;
	readonly daemon: ServerDaemon;
	readonly cli: ExperimentalCliRuntime;
	close(): Promise<void>;
};

export type ConfiguredCodingAgentDaemonRuntimeOptions = Omit<CodingAgentDaemonRuntimeOptions, "repository" | "env"> & {
	agentDir: string;
	cwd: string;
	databasePath?: string;
};

export type ConfiguredCodingAgentDaemonRuntime = CodingAgentDaemonRuntime & {
	repository: SqliteSessionRepository;
	env: NodeExecutionEnv;
};

export async function createCodingAgentDaemonRuntime(
	options: CodingAgentDaemonRuntimeOptions,
): Promise<CodingAgentDaemonRuntime> {
	const service = await createCodingAgentV2SqliteService(options);
	const agents = options.agents ?? (service.createSession ? createCodingAgentV2AgentRegistry(service) : undefined);
	const ownsAgents = options.agents === undefined && agents !== undefined && "dispose" in agents;
	const daemon = new ServerDaemon({
		service,
		socketPath: options.socketPath,
		...(options.serverId === undefined ? {} : { serverId: options.serverId }),
		...(agents === undefined ? {} : { agents }),
		...(options.createServer === undefined ? {} : { createServer: options.createServer }),
	});
	const defaultConnect: TransportAddress = { transport: "unix", path: options.socketPath };
	const cli = createExperimentalCliRuntime({
		daemon: {
			start: async (socket) => {
				if (socket !== undefined && socket !== options.socketPath)
					throw new Error(`Daemon is configured for socket ${options.socketPath}`);
				return daemon.start();
			},
			status: () => daemon.status(),
			stop: () => daemon.stop(),
		},
		defaultConnect,
		createClient: (address, auth) => {
			if (auth !== undefined) throw new Error("Experimental client authentication is not supported by Unix transport yet");
			return new PiClientV2({ transportFactory: createUnixTransportFactory({ path: address.path }) });
		},
		write: options.write,
		onAttach: options.onAttach,
	});
	return {
		service,
		daemon,
		cli,
		close: async () => {
			cli.close();
			const errors: unknown[] = [];
			try {
				await daemon.stop();
			} catch (error) {
				errors.push(error);
			}
			if (ownsAgents) {
				try {
					await (agents as { dispose(): Promise<void> }).dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to close coding-agent daemon runtime");
		},
	};
}

export async function createConfiguredCodingAgentDaemonRuntime(
	options: ConfiguredCodingAgentDaemonRuntimeOptions,
): Promise<ConfiguredCodingAgentDaemonRuntime> {
	const env = new NodeExecutionEnv({ cwd: options.cwd });
	const repository = new SqliteSessionRepository({
		env,
		sqlite: createNodeSqliteFactory(),
		databasePath: options.databasePath ?? join(options.agentDir, "server.sqlite"),
	});
	try {
		const runtime = await createCodingAgentDaemonRuntime({ ...options, repository, env });
		return {
			...runtime,
			repository,
			env,
			close: async () => {
				const errors: unknown[] = [];
				try {
					await runtime.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await repository.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await env.cleanup();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Failed to close configured daemon runtime");
			},
		};
	} catch (error) {
		const errors: unknown[] = [error];
		try {
			await repository.close();
		} catch (cleanupError) {
			errors.push(cleanupError);
		}
		try {
			await env.cleanup();
		} catch (cleanupError) {
			errors.push(cleanupError);
		}
		if (errors.length === 1) throw error;
		throw new AggregateError(errors, "Failed to create configured daemon runtime");
	}
}
