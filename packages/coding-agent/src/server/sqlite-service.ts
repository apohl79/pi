import {
	type CompactionSettings,
	type ExecutionEnv,
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
	V2WebService,
} from "@earendil-works/pi-server";
import type { SqliteSessionMetadata, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import {
	type CodingAgentAgentTools,
	type CreateCodingAgentHarnessOptions,
	createCodingAgentHarness,
} from "./create-harness.ts";
import { createPluginSamplingInput } from "./plugin-sampling.ts";
import {
	type CodingAgentV2Service,
	type CodingAgentV2SessionDefinition,
	type CodingAgentV2SessionStore,
	createCodingAgentV2ServiceFromStore,
} from "./v2-service.ts";

export interface CodingAgentV2SqliteServiceOptions {
	repository: SqliteSessionRepository;
	models: Models;
	env: ExecutionEnv | ((metadata: SqliteSessionMetadata) => ExecutionEnv | Promise<ExecutionEnv>);
	model: Model<Api> | ((metadata: SqliteSessionMetadata) => Model<Api> | Promise<Model<Api>>);
	compaction?: (model: Model<Api>) => CompactionSettings | undefined;
	pluginRegistry?: V2PluginRegistry;
	inputs?: V2InputRegistry;
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
		...(metadata.name === undefined ? {} : { sessionName: metadata.name }),
		cwd: metadata.cwd,
	};
}

export async function createCodingAgentV2SqliteService(
	options: CodingAgentV2SqliteServiceOptions,
): Promise<CodingAgentV2Service> {
	const metadataById = new Map<string, SqliteSessionMetadata>();
	const definition = async (
		metadata: SqliteSessionMetadata,
		session: Session<SqliteSessionMetadata>,
		modelOverride?: Model<Api>,
	): Promise<CodingAgentV2SessionDefinition> => {
		const model =
			modelOverride ?? (typeof options.model === "function" ? await options.model(metadata) : options.model);
		const env = typeof options.env === "function" ? await options.env(metadata) : options.env;
		const goals = new GoalManager(session);
		const compaction = options.compaction?.(model);
		const inputRegistry = options.inputs;
		const webService = options.web;
		const imageService = options.images;
		const planRegistry = options.plans;
		const agentRegistry =
			typeof options.agentRegistry === "function" ? options.agentRegistry() : options.agentRegistry;
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
				: { viewImage: async (reference) => imageService.view(metadata.id, reference) }),
			...(planRegistry === undefined
				? {}
				: {
						plans: {
							update: async (input) => planRegistry.update(metadata.id, input),
						},
					}),
			...(agentRegistry === undefined ? {} : { agents: createAgentTools(agentRegistry, metadata.id, model) }),
		});
		return {
			metadata: sessionMetadata(metadata),
			harness: created.harness,
			goals,
			...(inputRegistry === undefined ? {} : { inputs: inputRegistry }),
		};
	};
	const store: CodingAgentV2SessionStore = {
		list: async () => {
			const metadata = await options.repository.list();
			for (const item of metadata) metadataById.set(item.id, item);
			return metadata.map(sessionMetadata);
		},
		open: async (sessionId) => {
			const metadata =
				metadataById.get(sessionId) ?? (await options.repository.list()).find((item) => item.id === sessionId);
			if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
			metadataById.set(sessionId, metadata);
			return definition(metadata, await options.repository.open(metadata));
		},
		create: async (payload) => {
			const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
			const session = await options.repository.create({
				cwd,
				...(typeof payload.id === "string" ? { id: payload.id } : {}),
			});
			const metadata = await session.getMetadata();
			metadataById.set(metadata.id, metadata);
			const name = typeof payload.name === "string" ? payload.name : undefined;
			if (name !== undefined) {
				await session.setName(name);
				metadata.name = name;
			}
			const requestedModel =
				typeof payload.model === "object" && payload.model !== null && !Array.isArray(payload.model)
					? (payload.model as Record<string, unknown>)
					: undefined;
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
	return createCodingAgentV2ServiceFromStore(options.models, store);
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
