import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import {
	InMemoryForensicRecorder,
	InMemoryV2PlanRegistry,
	JsonlForensicRecorder,
	JsonlV2PlanRegistry,
	LocalDiagnosticCapsuleStore,
	NodeV2ProcessRegistry,
	ServerDaemon,
	type ServerDaemonOptions,
	type V2ImageService,
	type V2InputRegistry,
	type V2ProcessRegistry,
	type V2WebService,
} from "@earendil-works/pi-server";
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
	planStorePath?: string;
	diagnosticStorePath?: string;
	diagnosticKeyPath?: string;
	serverId?: string;
	agents?: ServerDaemonOptions["agents"];
	inputs?: V2InputRegistry;
	processes?: V2ProcessRegistry;
	web?: V2WebService;
	images?: V2ImageService;
	diagnostics?: ServerDaemonOptions["diagnostics"];
	createServer?: ServerDaemonOptions["createServer"];
	write(value: unknown): void;
	writeText?: (value: string) => void;
	runInteractive?: ExperimentalCliRuntimeOptions["runInteractive"];
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
	let createdAgents: ServerDaemonOptions["agents"];
	const plans =
		options.plans ??
		(options.planStorePath === undefined
			? new InMemoryV2PlanRegistry()
			: new JsonlV2PlanRegistry(options.planStorePath));
	const diagnostics =
		options.diagnostics ??
		(options.diagnosticStorePath === undefined
			? new InMemoryForensicRecorder()
			: new JsonlForensicRecorder(options.diagnosticStorePath));
	const diagnosticContent =
		options.diagnosticKeyPath === undefined ? undefined : new LocalDiagnosticCapsuleStore(options.diagnosticKeyPath);
	const processes = options.processes ?? new NodeV2ProcessRegistry();
	const service = await createCodingAgentV2SqliteService(
		options.agentRegistry === undefined
			? {
					...options,
					plans,
					agentRegistry: () => createdAgents,
				}
			: { ...options, plans },
	);
	const agents = options.agents ?? (service.createSession ? createCodingAgentV2AgentRegistry(service) : undefined);
	createdAgents = agents;
	const daemon = new ServerDaemon({
		service,
		socketPath: options.socketPath,
		...(options.serverId === undefined ? {} : { serverId: options.serverId }),
		...(agents === undefined ? {} : { agents }),
		...(options.inputs === undefined ? {} : { inputs: options.inputs }),
		processes,
		...(options.web === undefined ? {} : { web: options.web }),
		...(options.images === undefined ? {} : { images: options.images }),
		plans,
		diagnostics,
		...(diagnosticContent === undefined ? {} : { diagnosticContent }),
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
		createClient: (address) =>
			new PiClientV2({ transportFactory: createUnixTransportFactory({ path: address.path }) }),
		write: options.write,
		...(options.writeText === undefined ? {} : { writeText: options.writeText }),
		...(options.runInteractive === undefined ? {} : { runInteractive: options.runInteractive }),
		onAttach: options.onAttach,
	});
	return {
		service,
		daemon,
		cli,
		close: async () => {
			cli.close();
			await daemon.stop();
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
		const runtime = await createCodingAgentDaemonRuntime({
			...options,
			repository,
			env,
			planStorePath: options.planStorePath ?? join(options.agentDir, "plans.jsonl"),
			diagnosticStorePath: options.diagnosticStorePath ?? join(options.agentDir, "diagnostics.jsonl"),
			diagnosticKeyPath: options.diagnosticKeyPath ?? join(options.agentDir, "diagnostic-keys.json"),
		});
		return {
			...runtime,
			repository,
			env,
			close: async () => {
				await runtime.close();
				await repository.close();
				await env.cleanup();
			},
		};
	} catch (error) {
		await repository.close();
		await env.cleanup();
		throw error;
	}
}
