import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiClientV2 } from "@earendil-works/pi-client";
import { ClientDiagnosticSpool } from "@earendil-works/pi-client/diagnostics";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import {
	type DiagnosticIntegrityCheck,
	FileV2BlobStore,
	InMemoryForensicRecorder,
	InMemoryV2InputRegistry,
	InMemoryV2PlanRegistry,
	JsonlForensicRecorder,
	JsonlV2InputRegistry,
	JsonlV2OperationStore,
	JsonlV2PlanRegistry,
	JsonlV2UsageLedger,
	JsonV2PluginRegistry,
	LocalDiagnosticCapsuleStore,
	LocalV2FileReferenceService,
	NodeV2ProcessRegistry,
	ServerDaemon,
	type ServerDaemonOptions,
	type V2AppRegistry,
	type V2BlobStore,
	type V2FileReferenceService,
	type V2ImageService,
	type V2InputRegistry,
	type V2OperationStore,
	type V2PluginRegistry,
	type V2ProcessRegistry,
	type V2UsageLedger,
	type V2WebService,
} from "@earendil-works/pi-server";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import {
	createExperimentalCliRuntime,
	type ExperimentalCliRuntime,
	type ExperimentalCliRuntimeOptions,
} from "../cli/experimental/runtime.ts";
import type { TransportAddress } from "../cli/experimental/transport-address.ts";
import { runMigrations } from "../migrations.ts";
import { createCodingAgentV2AgentRegistry } from "./agent-registry.ts";
import { createRuntimeManifest } from "./runtime-manifest.ts";
import { type CodingAgentV2SqliteServiceOptions, createCodingAgentV2SqliteService } from "./sqlite-service.ts";

export type CodingAgentDaemonRuntimeOptions = Omit<CodingAgentV2SqliteServiceOptions, "repository"> & {
	repository: SqliteSessionRepository;
	socketPath: string;
	planStorePath?: string;
	diagnosticStorePath?: string;
	diagnosticKeyPath?: string;
	clientDiagnosticSpoolPath?: string;
	clientInstanceId?: string;
	integrity?: ServerDaemonOptions["integrity"];
	serverId?: string;
	runtimeManifest?: ServerDaemonOptions["runtimeManifest"];
	agents?: ServerDaemonOptions["agents"];
	inputs?: V2InputRegistry;
	inputStorePath?: string;
	usageStorePath?: string;
	usage?: V2UsageLedger;
	processes?: V2ProcessRegistry;
	web?: V2WebService;
	images?: V2ImageService;
	files?: V2FileReferenceService;
	pluginRegistry?: V2PluginRegistry;
	apps?: V2AppRegistry;
	operationStore?: V2OperationStore;
	operationStorePath?: string;
	blobs?: V2BlobStore;
	blobStorePath?: string;
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
	const inputs =
		options.inputs ??
		(options.inputStorePath === undefined
			? new InMemoryV2InputRegistry()
			: new JsonlV2InputRegistry(options.inputStorePath));
	const service = await createCodingAgentV2SqliteService(
		options.agentRegistry === undefined
			? {
					...options,
					inputs,
					plans,
					agentRegistry: () => createdAgents,
				}
			: { ...options, inputs, plans },
	);
	const agents = options.agents ?? (service.createSession ? createCodingAgentV2AgentRegistry(service) : undefined);
	createdAgents = agents;
	const daemon = new ServerDaemon({
		service,
		socketPath: options.socketPath,
		...(options.serverId === undefined ? {} : { serverId: options.serverId }),
		...(options.runtimeManifest === undefined ? {} : { runtimeManifest: options.runtimeManifest }),
		...(options.usage === undefined ? {} : { usage: options.usage }),
		...(agents === undefined ? {} : { agents }),
		inputs,
		processes,
		...(options.web === undefined ? {} : { web: options.web }),
		...(options.images === undefined ? {} : { images: options.images }),
		...(options.files === undefined ? {} : { files: options.files }),
		...(options.pluginRegistry === undefined ? {} : { plugins: options.pluginRegistry }),
		...(options.apps === undefined ? {} : { apps: options.apps }),
		...(options.operationStore === undefined ? {} : { operationStore: options.operationStore }),
		...(options.blobs === undefined ? {} : { blobs: options.blobs }),
		plans,
		diagnostics,
		...(options.integrity === undefined ? {} : { integrity: options.integrity }),
		...(diagnosticContent === undefined ? {} : { diagnosticContent }),
		...(options.createServer === undefined ? {} : { createServer: options.createServer }),
	});
	const clientRuntimeManifest = options.runtimeManifest ?? createRuntimeManifest();
	const clientSpool =
		options.clientDiagnosticSpoolPath === undefined
			? undefined
			: new ClientDiagnosticSpool({
					path: options.clientDiagnosticSpoolPath,
					clientInstanceId: options.clientInstanceId ?? `client-${process.pid}`,
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
		diagnosticsSpool: clientSpool,
		createClient: (address) =>
			new PiClientV2({
				transportFactory: createUnixTransportFactory({ path: address.path }),
				...(clientSpool === undefined
					? {}
					: {
							diagnostics: {
								manifest: {
									runtime: clientRuntimeManifest.runtime,
									platform: clientRuntimeManifest.platform,
									arch: clientRuntimeManifest.arch,
									...(clientRuntimeManifest.buildVersion === undefined
										? {}
										: { buildVersion: clientRuntimeManifest.buildVersion }),
									...(clientRuntimeManifest.forkCommit === undefined
										? {}
										: { forkCommit: clientRuntimeManifest.forkCommit }),
									...(clientRuntimeManifest.upstreamBaseCommit === undefined
										? {}
										: { upstreamBaseCommit: clientRuntimeManifest.upstreamBaseCommit }),
									...(clientRuntimeManifest.configHash === undefined
										? {}
										: { configHash: clientRuntimeManifest.configHash }),
								},
								spool: clientSpool,
							},
						}),
			}),
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
	const diagnostics =
		options.diagnostics ??
		new JsonlForensicRecorder(options.diagnosticStorePath ?? join(options.agentDir, "diagnostics.jsonl"));
	await diagnostics.record({ kind: "daemon_migration_started", outcome: "started" });
	try {
		runMigrations(options.cwd, options.agentDir);
		await diagnostics.record({ kind: "daemon_migration_completed", outcome: "ok" });
	} catch (error) {
		await diagnostics.record({
			kind: "daemon_migration_failed",
			severity: "error",
			outcome: "error",
			payload: { error: error instanceof Error ? error.name : "unknown" },
		});
		throw error;
	}
	const env = new NodeExecutionEnv({ cwd: options.cwd });
	const runtimeManifest = options.runtimeManifest ?? createRuntimeManifest();
	const repository = new SqliteSessionRepository({
		env,
		sqlite: createNodeSqliteFactory(),
		databasePath: options.databasePath ?? join(options.agentDir, "server.sqlite"),
	});
	try {
		const usage =
			options.usage ?? new JsonlV2UsageLedger(options.usageStorePath ?? join(options.agentDir, "usage.jsonl"));
		const pluginRegistry = options.pluginRegistry ?? new JsonV2PluginRegistry(join(options.agentDir, "plugins.json"));
		const operationStore =
			options.operationStore ??
			new JsonlV2OperationStore(options.operationStorePath ?? join(options.agentDir, "operations.jsonl"));
		const blobs = options.blobs ?? new FileV2BlobStore(options.blobStorePath ?? join(options.agentDir, "blobs"));
		const integrity =
			options.integrity ??
			(async () => {
				const checks: DiagnosticIntegrityCheck[] = [];
				try {
					checks.push({ name: "sessions", ok: true, details: { count: (await repository.list()).length } });
				} catch (error) {
					checks.push({
						name: "sessions",
						ok: false,
						details: { error: error instanceof Error ? error.name : "unknown" },
					});
				}
				try {
					const loaded = await operationStore.load();
					checks.push({
						name: "operations",
						ok: true,
						details: { operations: loaded.operations.length, events: loaded.events.length },
					});
				} catch (error) {
					checks.push({
						name: "operations",
						ok: false,
						details: { error: error instanceof Error ? error.name : "unknown" },
					});
				}
				try {
					checks.push({
						name: "plugins",
						ok: true,
						details: { count: (await pluginRegistry.listPlugins(true)).length },
					});
				} catch (error) {
					checks.push({
						name: "plugins",
						ok: false,
						details: { error: error instanceof Error ? error.name : "unknown" },
					});
				}
				try {
					if (blobs instanceof FileV2BlobStore) {
						const report = await blobs.verify();
						checks.push({
							name: "blobs",
							ok: report.ok,
							details: {
								metadataFiles: report.blobs,
								bytes: report.bytes,
								errors: [...report.errors],
							},
						});
					} else checks.push({ name: "blobs", ok: true, details: { metadataFiles: 0 } });
				} catch (error) {
					const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
					checks.push({ name: "blobs", ok: missing, details: { metadataFiles: 0, missing } });
				}
				try {
					const aggregate = await usage.aggregate();
					checks.push({
						name: "usage",
						ok: true,
						details: {
							responses: aggregate.responses,
							input: aggregate.input,
							output: aggregate.output,
							costUsd: aggregate.costUsd ?? null,
							pricingState: aggregate.pricingState,
						},
					});
				} catch (error) {
					checks.push({
						name: "usage",
						ok: false,
						details: { error: error instanceof Error ? error.name : "unknown" },
					});
				}
				return checks;
			});
		const runtime = await createCodingAgentDaemonRuntime({
			...options,
			repository,
			env,
			diagnostics,
			legacySessionImport: {
				fs: env,
				sessionsRoot: join(options.agentDir, "sessions"),
			},
			inputs:
				options.inputs ??
				new JsonlV2InputRegistry(options.inputStorePath ?? join(options.agentDir, "inputs.jsonl")),
			usage,
			files:
				options.files ??
				new LocalV2FileReferenceService({ projectRoot: options.cwd, cwd: options.cwd, allowAbsolute: true }),
			pluginRegistry,
			operationStore,
			blobs,
			integrity,
			runtimeManifest,
			planStorePath: options.planStorePath ?? join(options.agentDir, "plans.jsonl"),
			diagnosticStorePath: options.diagnosticStorePath ?? join(options.agentDir, "diagnostics.jsonl"),
			diagnosticKeyPath: options.diagnosticKeyPath ?? join(options.agentDir, "diagnostic-keys.json"),
			clientDiagnosticSpoolPath:
				options.clientDiagnosticSpoolPath ?? join(options.agentDir, "client-diagnostics.jsonl"),
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
