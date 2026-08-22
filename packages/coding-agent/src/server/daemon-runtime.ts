import { PiClientV2 } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { ServerDaemon, type ServerDaemonOptions } from "@earendil-works/pi-server";
import type { SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import {
	createExperimentalCliRuntime,
	type ExperimentalCliRuntime,
	type ExperimentalCliRuntimeOptions,
} from "../cli/experimental/runtime.ts";
import type { TransportAddress } from "../cli/experimental/transport-address.ts";
import { type CodingAgentV2SqliteServiceOptions, createCodingAgentV2SqliteService } from "./sqlite-service.ts";

export type CodingAgentDaemonRuntimeOptions = Omit<CodingAgentV2SqliteServiceOptions, "repository"> & {
	repository: SqliteSessionRepository;
	socketPath: string;
	serverId?: string;
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

export async function createCodingAgentDaemonRuntime(
	options: CodingAgentDaemonRuntimeOptions,
): Promise<CodingAgentDaemonRuntime> {
	const service = await createCodingAgentV2SqliteService(options);
	const daemon = new ServerDaemon({
		service,
		socketPath: options.socketPath,
		...(options.serverId === undefined ? {} : { serverId: options.serverId }),
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
			await daemon.stop();
		},
	};
}
