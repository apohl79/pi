import { join } from "node:path";
import type { CreateSessionV2Options } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { getAgentDir } from "../config.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import {
	type ConfiguredCodingAgentDaemonRuntime,
	type ConfiguredCodingAgentDaemonRuntimeOptions,
	createConfiguredCodingAgentDaemonRuntime,
} from "../server/daemon-runtime.ts";
import { RemoteV2Session, type RemoteV2SessionOptions } from "./remote-v2-session.ts";

export type CreateServerAgentSessionOptions = Partial<
	Omit<ConfiguredCodingAgentDaemonRuntimeOptions, "agentDir" | "cwd" | "socketPath" | "write" | "models" | "model">
> &
	Readonly<{
		agentDir?: string;
		cwd?: string;
		socketPath?: string;
		models?: ConfiguredCodingAgentDaemonRuntimeOptions["models"];
		model?: ConfiguredCodingAgentDaemonRuntimeOptions["model"];
		session?: CreateSessionV2Options;
		sessionOptions?: RemoteV2SessionOptions;
	}>;

export type ServerAgentSession = Readonly<{
	runtime: ConfiguredCodingAgentDaemonRuntime;
	client: PiClientV2;
	session: RemoteV2Session;
	close(): Promise<void>;
}>;

/** Create a daemon-owned SDK session. The returned close method owns client and daemon cleanup. */
export async function createServerAgentSession(
	options: CreateServerAgentSessionOptions = {},
): Promise<ServerAgentSession> {
	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = options.cwd ?? process.cwd();
	const socketPath = options.socketPath ?? join(agentDir, "pi.sock");
	const { session: sessionOptions, sessionOptions: remoteOptions, ...runtimeOptions } = options;
	const modelRuntime =
		options.models === undefined
			? await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					allowModelNetwork: false,
					refreshOnCreate: false,
				})
			: undefined;
	const models = options.models ?? modelRuntime;
	const model = options.model ?? models?.getModels()[0];
	if (models === undefined || model === undefined)
		throw new Error("No configured model is available for the server SDK");
	const runtime = await createConfiguredCodingAgentDaemonRuntime({
		...runtimeOptions,
		agentDir,
		cwd,
		socketPath,
		models,
		model,
		...(modelRuntime === undefined || runtimeOptions.fastModelResolver !== undefined
			? {}
			: {
					fastModelResolver: (selectedModel) => modelRuntime.getModelRole(selectedModel.provider, "fast"),
				}),
		write: () => undefined,
	});
	const client = new PiClientV2({ transportFactory: createUnixTransportFactory({ path: socketPath }) });
	try {
		await runtime.daemon.start();
		await client.connect();
		const session = await RemoteV2Session.create(client, sessionOptions, remoteOptions);
		return {
			runtime,
			client,
			session,
			close: async () => {
				await session.dispose();
				client.dispose();
				await runtime.close();
			},
		};
	} catch (error) {
		client.dispose();
		await runtime.close();
		throw error;
	}
}
