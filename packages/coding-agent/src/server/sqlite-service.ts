import {
	type AgentHarness,
	type CompactionSettings,
	type Entry,
	type ExecutionEnv,
	type GoalContinuationScheduler,
	GoalManager,
	loadPromptTemplates,
	type SamplingInput,
	type SamplingInputContext,
	type Session,
} from "@earendil-works/pi-agent-core";
import { type Api, estimateTextTokens, type Model, type Models } from "@earendil-works/pi-ai";
import type { SessionMetadataV2 } from "@earendil-works/pi-protocol";
import type {
	ForensicRecorder,
	V2AgentRegistry,
	V2BlobStore,
	V2ImageService,
	V2InputRegistry,
	V2PlanRegistry,
	V2PluginRegistry,
	V2ProcessRegistry,
	V2UsageAggregate,
	V2UsageLedger,
	V2UsageLedgerEntry,
	V2WebService,
} from "@earendil-works/pi-server";
import { hashV2PluginSet } from "@earendil-works/pi-server";
import type { SqliteSessionMetadata, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { resolveCodexPluginResourceOnDisk } from "../core/codex-plugin.ts";
import { loadSkillsFromDir } from "../core/skills.ts";
import {
	type CodingAgentAgentTools,
	type CodingAgentLifecycleHook,
	type CodingAgentLifecycleHookOutcome,
	type CreateCodingAgentHarnessOptions,
	createCodingAgentHarness,
} from "./create-harness.ts";
import { type ServerRuntimeExtension, ServerRuntimeExtensionHost } from "./extension-host.ts";
import { importLegacySessions, type LegacySessionImportOptions } from "./legacy-session-import.ts";
import { createPluginSamplingInput } from "./plugin-sampling.ts";
import {
	type CodingAgentV2Service,
	type CodingAgentV2SessionDefinition,
	type CodingAgentV2SessionStore,
	createCodingAgentV2ServiceFromStore,
} from "./v2-service.ts";

const SERVER_EXTENSION_STATE = "server_extension_state";

function persistedExtensionState(entries: readonly Entry[], extensionId: string, key: string): unknown {
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "custom" || entry.customType !== SERVER_EXTENSION_STATE) continue;
		if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) continue;
		const data = entry.data as Record<string, unknown>;
		if (data.extensionId === extensionId && data.key === key) return data.value;
	}
	return undefined;
}

export interface CodingAgentV2SqliteServiceOptions {
	repository: SqliteSessionRepository;
	legacySessionImport?: Omit<LegacySessionImportOptions, "repository">;
	models: Models;
	env: ExecutionEnv | ((metadata: SqliteSessionMetadata) => ExecutionEnv | Promise<ExecutionEnv>);
	model: Model<Api> | ((metadata: SqliteSessionMetadata) => Model<Api> | Promise<Model<Api>>);
	fastModel?: Model<Api>;
	fastModelResolver?: (model: Model<Api>) => Model<Api> | undefined;
	agentRoles?: Readonly<Record<string, CodingAgentRoleDefinition>>;
	goalContinuation?: (context: {
		goals: GoalManager;
		harness: AgentHarness;
		model: Model<Api>;
	}) => GoalContinuationScheduler | undefined;
	compaction?: (model: Model<Api>) => CompactionSettings | undefined;
	pluginRegistry?: V2PluginRegistry;
	diagnostics?: ForensicRecorder;
	inputs?: V2InputRegistry;
	usage?: V2UsageLedger;
	processes?: V2ProcessRegistry;
	web?: V2WebService;
	images?: V2ImageService;
	blobs?: V2BlobStore;
	plans?: V2PlanRegistry;
	serverExtensions?: readonly ServerRuntimeExtension[];
	agentRegistry?: V2AgentRegistry | (() => V2AgentRegistry | undefined);
	harness?: Omit<CreateCodingAgentHarnessOptions, "session" | "models" | "model" | "env" | "sessionFile">;
}

function sessionMetadata(metadata: SqliteSessionMetadata): SessionMetadataV2 {
	return {
		id: metadata.id,
		createdAt: metadata.createdAt,
		updatedAt: metadata.createdAt,
		...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
		...(metadata.name === undefined ? {} : { sessionName: metadata.name }),
		cwd: metadata.cwd,
	};
}

export interface CodingAgentRoleDefinition {
	readonly instructions?: string;
	readonly toolNames?: readonly string[];
	readonly model?: { readonly provider: string; readonly id: string };
}

function aggregateUsageEntries(entries: readonly V2UsageLedgerEntry[]): V2UsageAggregate {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	let imageUnits = 0;
	let costUsd = 0;
	let hasCost = true;
	let hasUnknown = false;
	let hasSubscription = false;
	for (const entry of entries) {
		input += entry.input;
		output += entry.output;
		cacheRead += entry.cacheRead;
		cacheWrite += entry.cacheWrite;
		reasoning += entry.reasoning ?? 0;
		imageUnits += entry.imageUnits ?? 0;
		if (entry.costUsd === undefined) hasCost = false;
		else costUsd += entry.costUsd;
		if (entry.pricing === "unknown") hasUnknown = true;
		if (entry.pricing === "subscription") hasSubscription = true;
	}
	return {
		responses: entries.length,
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning,
		imageUnits,
		...(hasCost ? { costUsd } : {}),
		pricingState: hasUnknown ? "unknown" : hasSubscription ? "subscription" : "known",
	};
}

export async function createCodingAgentV2SqliteService(
	options: CodingAgentV2SqliteServiceOptions,
): Promise<CodingAgentV2Service> {
	const metadataById = new Map<string, SqliteSessionMetadata>();
	let legacyImport: Promise<void> | undefined;
	const ensureLegacyImport = async (): Promise<void> => {
		if (options.legacySessionImport === undefined) return;
		legacyImport ??= importLegacySessions({ repository: options.repository, ...options.legacySessionImport }).then(
			() => undefined,
		);
		await legacyImport;
	};
	const definition = async (
		metadata: SqliteSessionMetadata,
		session: Session<SqliteSessionMetadata>,
		modelOverride?: Model<Api>,
	): Promise<CodingAgentV2SessionDefinition> => {
		const roleName =
			typeof metadata.metadata?.codingAgentRole === "string" ? metadata.metadata.codingAgentRole : undefined;
		const role = roleName === undefined ? undefined : options.agentRoles?.[roleName];
		const storedModel = metadata.metadata?.codingAgentModel;
		const storedModelOverride =
			typeof storedModel === "object" &&
			storedModel !== null &&
			!Array.isArray(storedModel) &&
			typeof (storedModel as { provider?: unknown }).provider === "string" &&
			typeof (storedModel as { id?: unknown }).id === "string"
				? options.models.getModel(
						(storedModel as { provider: string }).provider,
						(storedModel as { id: string }).id,
					)
				: undefined;
		const model =
			modelOverride ??
			storedModelOverride ??
			(typeof options.model === "function" ? await options.model(metadata) : options.model);
		const env = typeof options.env === "function" ? await options.env(metadata) : options.env;
		const goals = new GoalManager(session);
		const compaction = options.compaction?.(model);
		const inputRegistry = options.inputs;
		let disposing = false;
		const extensionHost =
			options.serverExtensions === undefined || options.serverExtensions.length === 0
				? undefined
				: new ServerRuntimeExtensionHost({
						resolveModel: () => ({ id: model.id, provider: model.provider }),
						loadState: async (extensionId, key) =>
							persistedExtensionState(
								await session.findEntries({ customType: SERVER_EXTENSION_STATE }),
								extensionId,
								key,
							),
						persistState: async (extensionId, key, value) => {
							await session.appendCustomEntry(SERVER_EXTENSION_STATE, { extensionId, key, value });
						},
					});
		if (extensionHost !== undefined) {
			for (const extension of options.serverExtensions ?? []) await extensionHost.register(extension);
		}
		const usageLedger = options.usage;
		const aggregateSessionUsage = async (): Promise<V2UsageAggregate> => {
			if (usageLedger === undefined) return aggregateUsageEntries([]);
			const sessions = await options.repository.list();
			const ids = new Set([metadata.id]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const item of sessions) {
					if (item.parentSessionId !== undefined && ids.has(item.parentSessionId) && !ids.has(item.id)) {
						ids.add(item.id);
						changed = true;
					}
				}
			}
			const entries = (await Promise.all([...ids].map((id) => usageLedger.read({ sessionId: id })))).flat();
			return aggregateUsageEntries(entries);
		};
		const scopedUsageLedger: V2UsageLedger | undefined =
			usageLedger === undefined
				? undefined
				: {
						record: (entry) => usageLedger.record(entry),
						read: (filter) => usageLedger.read(filter),
						aggregate: () => aggregateSessionUsage(),
					};
		const webService = options.web;
		const imageService = options.images;
		const planRegistry = options.plans;
		const agentRegistry =
			typeof options.agentRegistry === "function" ? options.agentRegistry() : options.agentRegistry;
		const modelInstructions: CreateCodingAgentHarnessOptions["modelInstructions"] = options.harness?.modelInstructions
			? {
					...options.harness.modelInstructions,
					scope:
						metadata.parentSessionId === undefined
							? (options.harness.modelInstructions.scope ?? "root")
							: "subagent",
				}
			: undefined;
		const activePlugins = options.pluginRegistry
			? (await options.pluginRegistry.listPlugins(true)).filter((plugin) => plugin.enabled)
			: [];
		const lifecycleHooks: CodingAgentLifecycleHook[] = activePlugins.flatMap((plugin) =>
			(plugin.hookDescriptors ?? []).flatMap((hook) =>
				hook.enabled && hook.command && (hook.event === "turn/accepted" || hook.event === "turn/completed")
					? [{ id: hook.id, event: hook.event, command: hook.command }]
					: [],
			),
		);
		const pluginSkills = (
			await Promise.all(
				activePlugins.flatMap((plugin) =>
					plugin.root === undefined
						? []
						: plugin.resources.skills.map(async (skillPath) => {
								const resolved = await resolveCodexPluginResourceOnDisk(plugin.root!, skillPath);
								if (!resolved.ok) return [];
								const loaded = loadSkillsFromDir({ dir: resolved.path, source: plugin.id });
								return loaded.skills.map((skill) => ({ ...skill, name: `${plugin.id}:${skill.name}` }));
							}),
				),
			)
		).flat();
		const pluginPromptTemplates = (
			await Promise.all(
				activePlugins.flatMap((plugin) =>
					plugin.root === undefined
						? []
						: plugin.resources.commands.map(async (commandPath) => {
								const resolved = await resolveCodexPluginResourceOnDisk(plugin.root!, commandPath);
								if (!resolved.ok) return [];
								const loaded = await loadPromptTemplates(env, resolved.path);
								return loaded.promptTemplates.map((template) => ({
									...template,
									name: `${plugin.id}:${template.name}`,
								}));
							}),
				),
			)
		).flat();
		const threadMessages = await createPluginSamplingInput(
			env,
			activePlugins.map((plugin, activationOrder) => ({
				pluginId: plugin.id,
				activationOrder,
				entries: plugin.threadContext ?? [],
			})),
		)({ model, systemPrompt: "", messages: [], tools: [] });
		const threadContext = threadMessages.flatMap((message) =>
			message.role === "user" && typeof message.content === "string" ? [message.content] : [],
		);
		const threadContextPrompt = threadContext.length > 0 ? threadContext.join("\n\n") : undefined;
		const baseSystemPromptOptions = options.harness?.systemPromptOptions;
		const baseResources = options.harness?.resources;
		const resources =
			pluginPromptTemplates.length === 0
				? baseResources
				: {
						...baseResources,
						promptTemplates: [...(baseResources?.promptTemplates ?? []), ...pluginPromptTemplates],
					};
		const systemPromptOptions =
			threadContextPrompt === undefined
				? pluginSkills.length === 0
					? baseSystemPromptOptions
					: { ...baseSystemPromptOptions, skills: [...(baseSystemPromptOptions?.skills ?? []), ...pluginSkills] }
				: {
						...baseSystemPromptOptions,
						...(pluginSkills.length === 0
							? {}
							: { skills: [...(baseSystemPromptOptions?.skills ?? []), ...pluginSkills] }),
						appendSystemPrompt: [options.harness?.systemPromptOptions?.appendSystemPrompt, threadContextPrompt]
							.filter((value): value is string => value !== undefined && value.length > 0)
							.join("\n\n"),
					};
		const samplingInputFactory = async (): Promise<SamplingInput> => {
			const configuredSamplingInput = options.harness?.samplingInputFactory
				? await options.harness.samplingInputFactory()
				: options.harness?.samplingInput;
			const plugins = options.pluginRegistry
				? (await options.pluginRegistry.listPlugins(true)).filter((plugin) => plugin.enabled)
				: [];
			const pluginSamplingInput = createPluginSamplingInput(
				env,
				plugins.map((plugin, activationOrder) => ({
					pluginId: plugin.id,
					activationOrder,
					entries: plugin.sampling,
				})),
				options.diagnostics === undefined
					? undefined
					: (diagnostic) => {
							void options.diagnostics
								?.record({
									kind: "plugin_sampling",
									severity: diagnostic.reason === "condition_error" ? "warn" : "info",
									sessionId: metadata.id,
									...(diagnostic.durationMs === undefined ? {} : { durationMs: diagnostic.durationMs }),
									payload: {
										pluginId: diagnostic.pluginId,
										entryId: diagnostic.entryId,
										reason: diagnostic.reason,
										...(diagnostic.characters === undefined ? {} : { characters: diagnostic.characters }),
										...(diagnostic.tokens === undefined ? {} : { tokens: diagnostic.tokens }),
										...(diagnostic.contentHash === undefined ? {} : { contentHash: diagnostic.contentHash }),
									},
								})
								.catch(() => {});
						},
			);
			return async (context: SamplingInputContext) => [
				...(configuredSamplingInput === undefined ? [] : await configuredSamplingInput(context)),
				...(await pluginSamplingInput(context)),
			];
		};
		const lifecycleHookOutcome =
			options.diagnostics === undefined
				? undefined
				: async (outcome: CodingAgentLifecycleHookOutcome) => {
						await options.diagnostics!.record({
							kind: "plugin_hook",
							severity: outcome.outcome === "ok" ? "info" : "warn",
							outcome: outcome.outcome,
							sessionId: metadata.id,
							durationMs: outcome.durationMs,
							payload: {
								hookId: outcome.id,
								event: outcome.event,
								outputBytes: outcome.outputBytes,
								truncated: outcome.truncated,
								...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
							},
						});
					};
		const created = await createCodingAgentHarness({
			...options.harness,
			...(role?.instructions === undefined ? {} : { roleInstructions: role.instructions }),
			activeToolNames:
				role?.toolNames === undefined
					? options.harness?.activeToolNames === undefined
						? undefined
						: [...options.harness.activeToolNames]
					: [...role.toolNames],
			...(modelInstructions === undefined ? {} : { modelInstructions }),
			...(systemPromptOptions === undefined ? {} : { systemPromptOptions }),
			session,
			models: options.models,
			model,
			env,
			...(compaction === undefined ? {} : { compaction }),
			goals,
			...(options.processes === undefined ? {} : { processes: options.processes }),
			...(resources === undefined ? {} : { resources }),
			samplingInputFactory,
			sessionFile: metadata.path,
			...(inputRegistry === undefined
				? {}
				: {
						requestUserInput: async (request, signal) => {
							const recovered = await inputRegistry.takeRespondedForSession(metadata.id);
							if (recovered !== undefined) return recovered;
							const pendingId = await inputRegistry.pendingForSession(metadata.id);
							const recoveredPending = pendingId !== undefined;
							const pending =
								pendingId === undefined
									? await inputRegistry.create(metadata.id, request.questions, request.autoResolutionMs)
									: await inputRegistry.read(pendingId);
							if (signal?.aborted && !recoveredPending) {
								if (!disposing) await inputRegistry.cancel(pending.id).catch(() => {});
								throw new Error("Input request aborted");
							}
							const abort = signal
								? new Promise<never>((_, reject) => {
										const onAbort = () => {
											if (!disposing && !recoveredPending) {
												reject(new Error("Input request aborted"));
												void inputRegistry.cancel(pending.id).catch(() => {});
											}
										};
										signal.addEventListener("abort", onAbort, { once: true });
									})
								: undefined;
							const resolved = await (abort === undefined
								? inputRegistry.wait(pending.id)
								: Promise.race([inputRegistry.wait(pending.id), abort]));
							if (resolved.status !== "responded") throw new Error(`Input request ${resolved.status}`);
							return resolved.answers ?? {};
						},
					}),
			...(webService === undefined ? {} : { web: async (request) => webService.execute(metadata.id, request) }),
			...(imageService === undefined
				? {}
				: {
						viewImage: async (reference) => imageService.view(metadata.id, reference),
						generateImage: async (request) => imageService.generate(metadata.id, request),
					}),
			...(lifecycleHooks.length === 0 ? {} : { lifecycleHooks }),
			...(lifecycleHookOutcome === undefined ? {} : { lifecycleHookOutcome }),
			...(planRegistry === undefined
				? {}
				: {
						plans: {
							update: async (input) => planRegistry.update(metadata.id, input),
						},
					}),
			...(agentRegistry === undefined ? {} : { agents: createAgentTools(agentRegistry, metadata.id, model) }),
		});
		const goalContinuation = options.goalContinuation?.({ goals, harness: created.harness, model });
		const instructionProfile =
			modelInstructions === undefined
				? undefined
				: async () => {
						const resolved = await modelInstructions.resolver.resolve(
							await created.harness.getModel(),
							modelInstructions.scope,
						);
						return resolved === undefined
							? undefined
							: {
									id: resolved.id,
									source: resolved.source,
									contentHash: resolved.contentHash,
									byteLength: resolved.byteLength,
									estimatedTokens: estimateTextTokens(resolved.text),
								};
					};
		const pluginSetHash =
			options.pluginRegistry === undefined
				? undefined
				: async () => hashV2PluginSet(await options.pluginRegistry!.listPlugins(true));
		const agents = agentRegistry === undefined ? undefined : async () => agentRegistry.list(metadata.id);
		const abortChildren =
			agentRegistry?.interruptSession === undefined
				? undefined
				: async () => agentRegistry.interruptSession!(metadata.id);
		const plan = planRegistry === undefined ? undefined : async () => planRegistry.read(metadata.id);
		const diagnostics =
			options.diagnostics === undefined
				? undefined
				: async () => {
						const events = await options.diagnostics!.read();
						const critical = events.filter((event) => event.severity === "error");
						return {
							capture: "metadata" as const,
							degraded: critical.length > 0,
							lastCriticalEventSeq: critical.at(-1)?.seq ?? 0,
						};
					};
		const queueWithReferences = async (items: Awaited<ReturnType<AgentHarness["getQueueSnapshot"]>>["steer"]) =>
			Promise.all(
				items.map(async (item) => {
					if (options.blobs === undefined || item.message.role !== "user" || !Array.isArray(item.message.content))
						return item;
					const content = [];
					for (const part of item.message.content) {
						if (part.type === "text") content.push({ type: "text" as const, text: part.text });
						else if (part.type === "image") {
							const blob = await options.blobs.put(Buffer.from(part.data, "base64"), part.mimeType);
							content.push({ type: "image" as const, digest: blob.digest, mimeType: blob.mimeType });
						}
					}
					return { ...item, content };
				}),
			);
		const queues = async () => {
			const snapshot = await created.harness.getQueueSnapshot();
			return {
				steer: await queueWithReferences(snapshot.steer),
				followUp: await queueWithReferences(snapshot.followUp),
			};
		};
		return {
			metadata: sessionMetadata(metadata),
			harness: created.harness,
			onDispose: () => {
				disposing = true;
			},
			recoveryState: created.suspended.length === 0 ? "clean" : "needsResolution",
			...(instructionProfile === undefined ? {} : { instructionProfile }),
			...(pluginSetHash === undefined ? {} : { pluginSetHash }),
			...(agents === undefined ? {} : { agents }),
			...(abortChildren === undefined ? {} : { abortChildren }),
			...(plan === undefined ? {} : { plan }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			queues,
			goals,
			...(goalContinuation === undefined ? {} : { goalContinuation }),
			...(inputRegistry === undefined ? {} : { inputs: inputRegistry }),
			...(scopedUsageLedger === undefined ? {} : { usage: scopedUsageLedger }),
			...(options.diagnostics === undefined ? {} : { forensicRecorder: options.diagnostics }),
			...(extensionHost === undefined ? {} : { extensionHost }),
		};
	};
	const store: CodingAgentV2SessionStore = {
		list: async () => {
			await ensureLegacyImport();
			const metadata = await options.repository.list();
			for (const item of metadata) metadataById.set(item.id, item);
			return metadata.map(sessionMetadata);
		},
		open: async (sessionId) => {
			await ensureLegacyImport();
			const metadata =
				metadataById.get(sessionId) ?? (await options.repository.list()).find((item) => item.id === sessionId);
			if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
			metadataById.set(sessionId, metadata);
			return definition(metadata, await options.repository.open(metadata));
		},
		create: async (payload) => {
			const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
			const roleName = typeof payload.role === "string" ? payload.role : undefined;
			const role = roleName === undefined ? undefined : options.agentRoles?.[roleName];
			if (roleName !== undefined && role === undefined) throw new Error(`Unknown coding-agent role: ${roleName}`);
			const modelResolution = payload.modelResolution === "inherited" ? "inherited" : "explicit";
			const requestedModel =
				typeof payload.model === "object" && payload.model !== null && !Array.isArray(payload.model)
					? (payload.model as Record<string, unknown>)
					: undefined;
			const selectedModel =
				role?.model !== undefined && modelResolution === "inherited" ? role.model : (requestedModel ?? role?.model);
			const session = await options.repository.create({
				cwd,
				...(typeof payload.id === "string" ? { id: payload.id } : {}),
				...(typeof payload.parentSessionId === "string" ? { parentSessionId: payload.parentSessionId } : {}),
				...(selectedModel === undefined
					? roleName === undefined
						? {}
						: { metadata: { codingAgentRole: roleName } }
					: {
							metadata: {
								codingAgentModel: selectedModel,
								...(roleName === undefined ? {} : { codingAgentRole: roleName }),
							},
						}),
			});
			const metadata = await session.getMetadata();
			metadataById.set(metadata.id, metadata);
			const name = typeof payload.name === "string" ? payload.name : undefined;
			if (name !== undefined) {
				await session.setName(name);
				metadata.name = name;
			}
			const modelOverride =
				selectedModel &&
				typeof selectedModel.provider === "string" &&
				typeof selectedModel.id === "string" &&
				selectedModel.provider !== "inherit" &&
				selectedModel.id !== "inherit"
					? options.models.getModel(selectedModel.provider, selectedModel.id)
					: undefined;
			if (selectedModel && modelOverride === undefined)
				throw new Error("Requested child model or role model is not available in the configured model catalog");
			return definition(metadata, session, modelOverride);
		},
		fork: async (sourceSessionId, payload) => {
			await ensureLegacyImport();
			const source =
				metadataById.get(sourceSessionId) ??
				(await options.repository.list()).find((item) => item.id === sourceSessionId);
			if (!source) throw new Error(`Unknown session: ${sourceSessionId}`);
			const scope = payload.scope === "tree" ? "tree" : "branch";
			const forked = await options.repository.fork(source, {
				...(scope === "tree" ? { scope: "tree" as const } : { scope: "branch" as const }),
				...(typeof payload.entryId === "string" ? { entryId: payload.entryId } : {}),
				...(payload.position === "before" || payload.position === "at" ? { position: payload.position } : {}),
				...(typeof payload.id === "string" ? { id: payload.id } : {}),
				cwd: typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : source.cwd,
			});
			const metadata = await forked.getMetadata();
			metadataById.set(metadata.id, metadata);
			const explicitForkName = typeof payload.name === "string" ? payload.name : undefined;
			if (explicitForkName !== undefined) {
				await forked.setName(explicitForkName);
				metadata.name = explicitForkName;
			}
			const created = await definition(metadata, forked);
			if (metadata.name !== undefined || explicitForkName !== undefined) {
				await created.harness.session.appendCustomEntry("session_name_state", {
					name: explicitForkName ?? metadata.name ?? null,
					source: explicitForkName === undefined ? "derived" : "explicit",
					revision: 0,
				});
			}
			await created.goals?.forkIdentity();
			return created;
		},
		delete: async (sessionId) => {
			const metadata =
				metadataById.get(sessionId) ?? (await options.repository.list()).find((item) => item.id === sessionId);
			if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
			await options.repository.delete(metadata);
			metadataById.delete(sessionId);
		},
	};
	return createCodingAgentV2ServiceFromStore(options.models, store, {
		...(options.fastModel === undefined ? {} : { fastModel: options.fastModel }),
		...(options.fastModelResolver === undefined ? {} : { fastModelResolver: options.fastModelResolver }),
	});
}

function createAgentTools(registry: V2AgentRegistry, sessionId: string, model: Model<Api>): CodingAgentAgentTools {
	return {
		spawn: (request) =>
			registry.spawn({
				sessionId,
				parentPath: "/root",
				taskName: request.taskName,
				taskMessage: request.taskMessage,
				...(request.role === undefined ? {} : { role: request.role }),
				...(request.forkTurns === undefined ? {} : { forkTurns: request.forkTurns }),
				model: request.model ?? { provider: model.provider, id: model.id },
				modelResolution:
					request.model === undefined ||
					(request.model.provider === model.provider && request.model.id === model.id)
						? "inherited"
						: "explicit",
			}),
		list: () => registry.list(sessionId),
		wait: (agentId, timeoutMs) => registry.wait(agentId, timeoutMs),
		message: (agentId, message) => registry.message(agentId, message),
		followUp: (agentId, message) => registry.followUp(agentId, message),
		interrupt: (agentId) => registry.interrupt(agentId),
	};
}
