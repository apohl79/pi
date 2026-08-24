import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiClientV2 } from "@earendil-works/pi-client";
import { ClientDiagnosticSpool } from "@earendil-works/pi-client/diagnostics";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import {
	type DiagnosticIntegrityCheck,
	FileV2BlobStore,
	type ForensicRecorder,
	InMemoryForensicRecorder,
	InMemoryV2InputRegistry,
	InMemoryV2PlanRegistry,
	JsonlForensicRecorder,
	JsonlV2InputRegistry,
	JsonlV2PlanRegistry,
	JsonlV2ProcessRegistry,
	JsonV2AppCredentialStore,
	JsonV2PluginRegistry,
	LocalDiagnosticCapsuleStore,
	LocalV2FileReferenceService,
	NodeV2ProcessRegistry,
	ServerDaemon,
	type ServerDaemonOptions,
	TeeForensicRecorder,
	type V2AppCredentialStore,
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
import { acquireCodexMarketplacePlugin, type CodexPluginAcquisitionOptions } from "../core/codex-plugin-acquisition.ts";
import { CodexPluginActivationStore } from "../core/codex-plugin-activation.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { runMigrations } from "../migrations.ts";
import { type CodingAgentV2AgentRegistryOptions, createCodingAgentV2AgentRegistry } from "./agent-registry.ts";
import { createCodingAgentNativePtyLauncher } from "./native-pty.ts";
import { inspectPiExtensionServerCompatibility } from "./pi-extension-adapter.ts";
import {
	AcquiringV2PluginRegistry,
	ActivatingV2PluginRegistry,
	type CodexPluginMarketplaceResolver,
} from "./plugin-registry.ts";
import { createRuntimeManifest } from "./runtime-manifest.ts";
import { SqliteForensicRecorder } from "./sqlite-forensic-recorder.ts";
import { SqliteV2InputRegistry } from "./sqlite-input-registry.ts";
import { SqliteV2OperationStore } from "./sqlite-operation-store.ts";
import { SqliteV2PlanRegistry } from "./sqlite-plan-registry.ts";
import { type CodingAgentV2SqliteServiceOptions, createCodingAgentV2SqliteService } from "./sqlite-service.ts";
import { SqliteV2UsageLedger } from "./sqlite-usage-ledger.ts";

export type CodingAgentDaemonRuntimeOptions = Omit<CodingAgentV2SqliteServiceOptions, "repository"> & {
	repository: SqliteSessionRepository;
	socketPath: string;
	planStorePath?: string;
	diagnosticStorePath?: string;
	diagnosticLogPath?: string;
	diagnosticLogMaxBytes?: number;
	diagnosticLogMaxFiles?: number;
	diagnosticKeyPath?: string;
	clientDiagnosticSpoolPath?: string;
	clientInstanceId?: string;
	lifecycleMarkerPath?: string;
	integrity?: ServerDaemonOptions["integrity"];
	repairSafe?: ServerDaemonOptions["repairSafe"];
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
	pluginMarketplaceResolver?: CodexPluginMarketplaceResolver;
	pluginAcquisition?: CodexPluginAcquisitionOptions;
	pluginActivationStore?: CodexPluginActivationStore;
	apps?: V2AppRegistry;
	appCredentials?: V2AppCredentialStore;
	operationStore?: V2OperationStore;
	operationStorePath?: string;
	/** Bounds for the default server-owned child-agent registry. */
	agentMaxDepth?: CodingAgentV2AgentRegistryOptions["maxDepth"];
	agentMaxActive?: CodingAgentV2AgentRegistryOptions["maxActive"];
	agentMaxActivePerParent?: CodingAgentV2AgentRegistryOptions["maxActivePerParent"];
	blobs?: V2BlobStore;
	blobStorePath?: string;
	diagnostics?: ServerDaemonOptions["diagnostics"];
	createServer?: ServerDaemonOptions["createServer"];
	write(value: unknown): void;
	writeText?: (value: string) => void;
	rpcInput?: ExperimentalCliRuntimeOptions["rpcInput"];
	rpcOutput?: ExperimentalCliRuntimeOptions["rpcOutput"];
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
	extensionPaths?: readonly string[];
	skillPaths?: readonly string[];
	promptTemplatePaths?: readonly string[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noContextFiles?: boolean;
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
	const primaryDiagnostics =
		options.diagnostics ??
		(options.diagnosticStorePath === undefined
			? new InMemoryForensicRecorder()
			: new JsonlForensicRecorder(options.diagnosticStorePath));
	const diagnostics =
		options.diagnosticLogPath === undefined
			? primaryDiagnostics
			: new TeeForensicRecorder(
					primaryDiagnostics,
					new JsonlForensicRecorder(options.diagnosticLogPath, {
						...(options.diagnosticLogMaxBytes === undefined ? {} : { maxBytes: options.diagnosticLogMaxBytes }),
						...(options.diagnosticLogMaxFiles === undefined ? {} : { maxFiles: options.diagnosticLogMaxFiles }),
					}),
				);
	const diagnosticContent =
		options.diagnosticKeyPath === undefined ? undefined : new LocalDiagnosticCapsuleStore(options.diagnosticKeyPath);
	const processes =
		options.processes ?? new NodeV2ProcessRegistry({ ptyLauncher: createCodingAgentNativePtyLauncher() });
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
					diagnostics,
					processes,
					agentRegistry: () => createdAgents,
				}
			: { ...options, inputs, plans, diagnostics, processes },
	);
	const agents =
		options.agents ??
		(service.createSession
			? createCodingAgentV2AgentRegistry(service, {
					diagnostics,
					...(options.agentMaxDepth === undefined ? {} : { maxDepth: options.agentMaxDepth }),
					...(options.agentMaxActive === undefined ? {} : { maxActive: options.agentMaxActive }),
					...(options.agentMaxActivePerParent === undefined
						? {}
						: { maxActivePerParent: options.agentMaxActivePerParent }),
				})
			: undefined);
	createdAgents = agents;
	const daemon = new ServerDaemon({
		service,
		socketPath: options.socketPath,
		...(options.serverId === undefined ? {} : { serverId: options.serverId }),
		...(options.lifecycleMarkerPath === undefined ? {} : { lifecycleMarkerPath: options.lifecycleMarkerPath }),
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
		...(options.appCredentials === undefined ? {} : { appCredentials: options.appCredentials }),
		...(options.operationStore === undefined ? {} : { operationStore: options.operationStore }),
		...(options.blobs === undefined ? {} : { blobs: options.blobs }),
		plans,
		diagnostics,
		...(options.integrity === undefined ? {} : { integrity: options.integrity }),
		repairSafe:
			options.repairSafe ??
			(async () => {
				const repairedSessions = await options.repository.repairDerivedIndexes();
				return [
					{
						name: "session-branch-cache",
						ok: true,
						details: { sessions: repairedSessions.length },
					},
				];
			}),
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
			stop: () => daemon.stopPersisted(),
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
									clientInstanceId: clientSpool.clientInstanceId,
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
		...(options.rpcInput === undefined ? {} : { rpcInput: options.rpcInput }),
		...(options.rpcOutput === undefined ? {} : { rpcOutput: options.rpcOutput }),
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
	const primaryDiagnostics =
		options.diagnostics ??
		new SqliteForensicRecorder(options.diagnosticStorePath ?? join(options.agentDir, "diagnostics.sqlite"));
	const diagnostics = new TeeForensicRecorder(
		primaryDiagnostics,
		new JsonlForensicRecorder(options.diagnosticLogPath ?? join(options.agentDir, "diagnostic-log.jsonl"), {
			...(options.diagnosticLogMaxBytes === undefined ? {} : { maxBytes: options.diagnosticLogMaxBytes }),
			...(options.diagnosticLogMaxFiles === undefined ? {} : { maxFiles: options.diagnosticLogMaxFiles }),
		}),
	);
	let discoveredPiExtensions = options.piExtensions;
	let resourceLoader: DefaultResourceLoader | undefined;
	let piExtensionLoadErrors: readonly { path: string; error: string }[] = [];
	if (discoveredPiExtensions === undefined) {
		resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: options.agentDir,
			...(options.extensionPaths === undefined ? {} : { additionalExtensionPaths: [...options.extensionPaths] }),
			...(options.skillPaths === undefined ? {} : { additionalSkillPaths: [...options.skillPaths] }),
			...(options.promptTemplatePaths === undefined
				? {}
				: { additionalPromptTemplatePaths: [...options.promptTemplatePaths] }),
			...(options.noExtensions === undefined ? {} : { noExtensions: options.noExtensions }),
			...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
			...(options.noPromptTemplates === undefined ? {} : { noPromptTemplates: options.noPromptTemplates }),
			...(options.noContextFiles === undefined ? {} : { noContextFiles: options.noContextFiles }),
		});
		try {
			await resourceLoader.reload();
		} catch (error) {
			await diagnostics.record({
				kind: "pi_extension_load",
				severity: "error",
				payload: { error: error instanceof Error ? error.message.slice(0, 500) : "unknown" },
			});
			throw error;
		}
		const extensionsResult = resourceLoader.getExtensions();
		discoveredPiExtensions = extensionsResult.extensions;
		piExtensionLoadErrors = extensionsResult.errors;
	}
	const piExtensionCompatibility = (discoveredPiExtensions ?? []).map(inspectPiExtensionServerCompatibility);
	for (const report of piExtensionCompatibility) {
		if (report.unsupported.length === 0) continue;
		await diagnostics.record({
			kind: "pi_extension_compatibility",
			severity: "warn",
			payload: { extensionPath: report.extensionPath, unsupported: [...report.unsupported] },
		});
	}
	for (const error of piExtensionLoadErrors) {
		await diagnostics.record({
			kind: "pi_extension_load",
			severity: "warn",
			payload: { extensionPath: error.path, error: error.error.slice(0, 500) },
		});
	}
	const migrationSpool =
		options.diagnostics === undefined
			? new JsonlForensicRecorder(options.diagnosticStorePath ?? join(options.agentDir, "diagnostics.jsonl"))
			: undefined;
	const recordMigrationDiagnostic = async (event: Parameters<ForensicRecorder["record"]>[0]): Promise<void> => {
		try {
			await diagnostics.record(event);
			await migrationSpool?.record(event);
		} catch {
			// Diagnostic persistence must not mask startup or migration outcomes.
		}
	};
	await recordMigrationDiagnostic({ kind: "daemon_migration_started", outcome: "started" });
	try {
		runMigrations(options.cwd, options.agentDir);
		await recordMigrationDiagnostic({ kind: "daemon_migration_completed", outcome: "ok" });
	} catch (error) {
		await recordMigrationDiagnostic({
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
			options.usage ?? new SqliteV2UsageLedger(options.usageStorePath ?? join(options.agentDir, "usage.sqlite"));
		const pluginAcquisition = options.pluginAcquisition;
		const pluginMarketplaceResolver =
			options.pluginMarketplaceResolver ??
			(pluginAcquisition === undefined
				? undefined
				: async (marketplace: Parameters<CodexPluginMarketplaceResolver>[0], pluginName: string) => {
						const acquired = await acquireCodexMarketplacePlugin(marketplace.source, pluginName, {
							...pluginAcquisition,
							baseRoot: pluginAcquisition.baseRoot ?? options.cwd,
						});
						return { root: acquired.root, manifest: acquired.manifest };
					});
		const pluginRegistry =
			options.pluginRegistry === undefined
				? (() => {
						const activated = new ActivatingV2PluginRegistry(
							new JsonV2PluginRegistry(join(options.agentDir, "plugins.json")),
							options.pluginActivationStore ??
								new CodexPluginActivationStore(join(options.agentDir, "plugins-cache")),
						);
						return pluginMarketplaceResolver === undefined
							? activated
							: new AcquiringV2PluginRegistry(activated, pluginMarketplaceResolver);
					})()
				: options.pluginRegistry;
		const plans =
			options.plans ?? new SqliteV2PlanRegistry(options.planStorePath ?? join(options.agentDir, "plans.sqlite"));
		const inputs =
			options.inputs ?? new SqliteV2InputRegistry(options.inputStorePath ?? join(options.agentDir, "inputs.sqlite"));
		const operationStore =
			options.operationStore ??
			new SqliteV2OperationStore(options.operationStorePath ?? join(options.agentDir, "operations.sqlite"));
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
				try {
					const inspection = await repository.verifyReopen();
					checks.push({
						name: "sqlite",
						ok: inspection.healthy,
						details: {
							schemaVersion: inspection.schemaVersion,
							quickCheck: inspection.quickCheck,
							foreignKeyErrors: inspection.foreignKeyErrors.length,
							reopened: true,
						},
					});
				} catch (error) {
					checks.push({
						name: "sqlite",
						ok: false,
						details: { error: error instanceof Error ? error.name : "unknown" },
					});
				}
				return checks;
			});
		const loaderSkills =
			resourceLoader === undefined
				? []
				: await Promise.all(
						resourceLoader.getSkills().skills.map(async (skill) => ({
							name: skill.name,
							description: skill.description,
							content: await readFile(skill.filePath, "utf8"),
							filePath: skill.filePath,
							disableModelInvocation: skill.disableModelInvocation,
						})),
					);
		const runtime = await createCodingAgentDaemonRuntime({
			...options,
			harness:
				resourceLoader === undefined
					? options.harness
					: {
							...options.harness,
							resources: {
								...(options.harness?.resources ?? {}),
								skills: [...loaderSkills, ...(options.harness?.resources?.skills ?? [])],
								promptTemplates: [
									...resourceLoader.getPrompts().prompts,
									...(options.harness?.resources?.promptTemplates ?? []),
								],
							},
							systemPromptOptions: {
								...(resourceLoader.getSystemPrompt() === undefined
									? {}
									: { customPrompt: resourceLoader.getSystemPrompt() }),
								...(resourceLoader.getAppendSystemPrompt().length === 0
									? {}
									: { appendSystemPrompt: resourceLoader.getAppendSystemPrompt().join("\n\n") }),
								...(resourceLoader.getAgentsFiles().agentsFiles.length === 0
									? {}
									: { contextFiles: resourceLoader.getAgentsFiles().agentsFiles }),
								...(options.harness?.systemPromptOptions ?? {}),
							},
						},
			piExtensions: discoveredPiExtensions,
			repository,
			env,
			diagnostics,
			legacySessionImport: {
				fs: env,
				sessionsRoot: join(options.agentDir, "sessions"),
			},
			inputs,
			usage,
			plans,
			files:
				options.files ??
				new LocalV2FileReferenceService({ projectRoot: options.cwd, cwd: options.cwd, allowAbsolute: true }),
			pluginRegistry,
			appCredentials:
				options.appCredentials ?? new JsonV2AppCredentialStore(join(options.agentDir, "app-credentials.json")),
			operationStore,
			blobs,
			integrity,
			runtimeManifest,
			planStorePath: options.planStorePath ?? join(options.agentDir, "plans.jsonl"),
			diagnosticStorePath: options.diagnosticStorePath ?? join(options.agentDir, "diagnostics.jsonl"),
			diagnosticKeyPath: options.diagnosticKeyPath ?? join(options.agentDir, "diagnostic-keys.json"),
			clientDiagnosticSpoolPath:
				options.clientDiagnosticSpoolPath ?? join(options.agentDir, "client-diagnostics.jsonl"),
			lifecycleMarkerPath: options.lifecycleMarkerPath ?? join(options.agentDir, "daemon-state.json"),
			processes:
				options.processes ??
				new JsonlV2ProcessRegistry(
					join(options.agentDir, "processes.jsonl"),
					new NodeV2ProcessRegistry({ ptyLauncher: createCodingAgentNativePtyLauncher() }),
				),
		});
		return {
			...runtime,
			repository,
			env,
			close: async () => {
				await runtime.close();
				await diagnostics.flush?.();
				if (operationStore instanceof SqliteV2OperationStore) await operationStore.close();
				if (usage instanceof SqliteV2UsageLedger) await usage.close();
				if (plans instanceof SqliteV2PlanRegistry) await plans.close();
				if (inputs instanceof SqliteV2InputRegistry) await inputs.close();
				if (primaryDiagnostics instanceof SqliteForensicRecorder) await primaryDiagnostics.close();
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
