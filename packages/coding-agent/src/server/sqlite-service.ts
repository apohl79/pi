import { resolve } from "node:path";
import {
	type AgentHarness,
	type CompactionSettings,
	type ExecutionEnv,
	type GoalContinuationScheduler,
	GoalManager,
	type SamplingInput,
	type SamplingInputContext,
	type Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { SessionMetadataV2 } from "@earendil-works/pi-protocol";
import type {
	V2AgentRegistry,
	V2ImageService,
	V2InputRegistry,
	V2PlanRegistry,
	V2PluginRegistry,
	V2UsageLedger,
	V2WebService,
} from "@earendil-works/pi-server";
import type { SqliteSessionMetadata, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { loadSkillsFromDir } from "../core/skills.ts";
import {
	type CodingAgentAgentTools,
	type CodingAgentLifecycleHook,
	type CreateCodingAgentHarnessOptions,
	createCodingAgentHarness,
} from "./create-harness.ts";
import { importLegacySessions, type LegacySessionImportOptions } from "./legacy-session-import.ts";
import { createPluginSamplingInput } from "./plugin-sampling.ts";
import {
	type CodingAgentV2Service,
	type CodingAgentV2SessionDefinition,
	type CodingAgentV2SessionStore,
	createCodingAgentV2ServiceFromStore,
} from "./v2-service.ts";

export interface CodingAgentV2SqliteServiceOptions {
	repository: SqliteSessionRepository;
	legacySessionImport?: Omit<LegacySessionImportOptions, "repository">;
	models: Models;
	env: ExecutionEnv | ((metadata: SqliteSessionMetadata) => ExecutionEnv | Promise<ExecutionEnv>);
	model: Model<Api> | ((metadata: SqliteSessionMetadata) => Model<Api> | Promise<Model<Api>>);
	fastModel?: Model<Api>;
	goalContinuation?: (context: {
		goals: GoalManager;
		harness: AgentHarness;
		model: Model<Api>;
	}) => GoalContinuationScheduler | undefined;
	compaction?: (model: Model<Api>) => CompactionSettings | undefined;
	pluginRegistry?: V2PluginRegistry;
	inputs?: V2InputRegistry;
	usage?: V2UsageLedger;
	web?: V2WebService;
	images?: V2ImageService;
	plans?: V2PlanRegistry;
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
		const usageLedger = options.usage;
		const webService = options.web;
		const imageService = options.images;
		const planRegistry = options.plans;
		const agentRegistry =
			typeof options.agentRegistry === "function" ? options.agentRegistry() : options.agentRegistry;
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
								const root = resolve(plugin.root!);
								const path = resolve(root, skillPath);
								if (path !== root && !path.startsWith(`${root}/`)) return [];
								const loaded = loadSkillsFromDir({ dir: path, source: plugin.id });
								return loaded.skills.map((skill) => ({ ...skill, name: `${plugin.id}:${skill.name}` }));
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
			);
			return async (context: SamplingInputContext) => [
				...(configuredSamplingInput === undefined ? [] : await configuredSamplingInput(context)),
				...(await pluginSamplingInput(context)),
			];
		};
		const created = await createCodingAgentHarness({
			...options.harness,
			...(systemPromptOptions === undefined ? {} : { systemPromptOptions }),
			session,
			models: options.models,
			model,
			env,
			...(compaction === undefined ? {} : { compaction }),
			goals,
			samplingInputFactory,
			sessionFile: metadata.path,
			...(inputRegistry === undefined
				? {}
				: {
						requestUserInput: async (request, signal) => {
							const recovered = await inputRegistry.takeRespondedForSession(metadata.id);
							if (recovered !== undefined) return recovered;
							const pending = await inputRegistry.create(
								metadata.id,
								request.questions,
								request.autoResolutionMs,
							);
							if (signal?.aborted) {
								await inputRegistry.cancel(pending.id).catch(() => {});
								throw new Error("Input request aborted");
							}
							const abort = signal
								? new Promise<never>((_, reject) => {
										const onAbort = () => {
											reject(new Error("Input request aborted"));
											void inputRegistry.cancel(pending.id).catch(() => {});
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
		return {
			metadata: sessionMetadata(metadata),
			harness: created.harness,
			goals,
			...(goalContinuation === undefined ? {} : { goalContinuation }),
			...(inputRegistry === undefined ? {} : { inputs: inputRegistry }),
			...(usageLedger === undefined ? {} : { usage: usageLedger }),
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
			const requestedModel =
				typeof payload.model === "object" && payload.model !== null && !Array.isArray(payload.model)
					? (payload.model as Record<string, unknown>)
					: undefined;
			const session = await options.repository.create({
				cwd,
				...(typeof payload.id === "string" ? { id: payload.id } : {}),
				...(typeof payload.parentSessionId === "string" ? { parentSessionId: payload.parentSessionId } : {}),
				...(requestedModel === undefined ? {} : { metadata: { codingAgentModel: requestedModel } }),
			});
			const metadata = await session.getMetadata();
			metadataById.set(metadata.id, metadata);
			const name = typeof payload.name === "string" ? payload.name : undefined;
			if (name !== undefined) {
				await session.setName(name);
				metadata.name = name;
			}
			const modelOverride =
				requestedModel &&
				typeof requestedModel.provider === "string" &&
				typeof requestedModel.id === "string" &&
				requestedModel.provider !== "inherit" &&
				requestedModel.id !== "inherit"
					? options.models.getModel(requestedModel.provider, requestedModel.id)
					: undefined;
			if (requestedModel && modelOverride === undefined)
				throw new Error("Requested child model is not available in the configured model catalog");
			return definition(metadata, session, modelOverride);
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
	});
}

function createAgentTools(registry: V2AgentRegistry, sessionId: string, model: Model<Api>): CodingAgentAgentTools {
	return {
		spawn: (request) =>
			registry.spawn({
				sessionId,
				parentPath: `/${sessionId}`,
				taskName: request.taskName,
				taskMessage: request.taskMessage,
				...(request.role === undefined ? {} : { role: request.role }),
				model: request.model ?? { provider: model.provider, id: model.id },
			}),
		list: () => registry.list(sessionId),
		wait: (agentId, timeoutMs) => registry.wait(agentId, timeoutMs),
		message: (agentId, message) => registry.message(agentId, message),
		followUp: (agentId, message) => registry.followUp(agentId, message),
		interrupt: (agentId) => registry.interrupt(agentId),
	};
}
