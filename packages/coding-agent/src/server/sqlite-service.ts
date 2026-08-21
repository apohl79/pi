import type { ExecutionEnv, Session } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { SessionMetadataV2 } from "@earendil-works/pi-protocol";
import type { SqliteSessionMetadata, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { type CreateCodingAgentHarnessOptions, createCodingAgentHarness } from "./create-harness.ts";
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
	const definition = async (
		metadata: SqliteSessionMetadata,
		session: Session<SqliteSessionMetadata>,
		modelOverride?: Model<Api>,
	): Promise<CodingAgentV2SessionDefinition> => {
		const model =
			modelOverride ?? (typeof options.model === "function" ? await options.model(metadata) : options.model);
		const env = typeof options.env === "function" ? await options.env(metadata) : options.env;
		const created = await createCodingAgentHarness({
			...options.harness,
			session,
			models: options.models,
			model,
			env,
			sessionFile: metadata.path,
		});
		return { metadata: sessionMetadata(metadata), harness: created.harness };
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
				...(typeof payload.parentSessionId === "string" ? { parentSessionId: payload.parentSessionId } : {}),
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
