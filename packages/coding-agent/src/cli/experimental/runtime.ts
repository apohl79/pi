import type { PiClientV2, PiSessionV2Handle } from "@earendil-works/pi-client";
import type { ExperimentalCliContext } from "./cli.ts";
import type { AuthInput } from "./auth.ts";
import type { AttachCommand } from "./commands/attach.ts";
import type { ClientCommand } from "./commands/client.ts";
import type { ServerCommand } from "./commands/server.ts";
import type { SessionsCommand } from "./commands/sessions.ts";
import type { TransportAddress } from "./transport-address.ts";

export type ExperimentalDaemonController = {
	start(socket?: string): Promise<unknown>;
	status(): unknown;
	stop(): Promise<unknown>;
};

export type ExperimentalCliRuntimeOptions = {
	daemon: ExperimentalDaemonController;
	defaultConnect: TransportAddress;
	createClient(address: TransportAddress, auth?: AuthInput): PiClientV2;
	write(value: unknown): void;
	onAttach?(handle: PiSessionV2Handle): void | Promise<void>;
};

export type ExperimentalCliRuntime = ExperimentalCliContext & {
	close(): void;
};

export function createExperimentalCliRuntime(options: ExperimentalCliRuntimeOptions): ExperimentalCliRuntime {
	const clients = new Set<PiClientV2>();
	const connect = (address: TransportAddress, auth?: AuthInput): PiClientV2 => {
		const client = options.createClient(address, auth);
		clients.add(client);
		return client;
	};
	const addressFor = (address: TransportAddress | undefined): TransportAddress => address ?? options.defaultConnect;
	const closeClient = (client: PiClientV2): void => {
		clients.delete(client);
		client.dispose();
	};
	const runServer = async (command: ServerCommand): Promise<void> => {
		if (command.auth !== undefined) throw new Error("Experimental server authentication is not supported yet");
		if (command.listen !== undefined && command.listen.length > 0)
			throw new Error("Experimental server --listen is not supported by this daemon runtime yet");
		const result =
			command.action === "stop"
				? await options.daemon.stop()
				: command.action === "status"
					? options.daemon.status()
					: await options.daemon.start(command.socket);
		options.write(result);
	};
	const runClient = async (command: ClientCommand): Promise<void> => {
		const client = connect(addressFor(command.connect), command.auth);
		try {
			const snapshot = await client.connect();
			options.write(snapshot);
		} finally {
			closeClient(client);
		}
	};
	const runSessions = async (command: SessionsCommand): Promise<void> => {
		const client = connect(addressFor(command.connect), command.auth);
		try {
			await client.connect();
			options.write(await client.listSessions());
		} finally {
			closeClient(client);
		}
	};
	const runAttach = async (command: AttachCommand): Promise<void> => {
		if (command.sessionId === undefined) throw new Error("attach requires a session id");
		const client = connect(addressFor(command.connect), command.auth);
		let handedOff = false;
		try {
			await client.connect();
			const handle = await client.openSession(command.sessionId);
			if (options.onAttach === undefined) {
				options.write(await handle.read());
				return;
			}
			await options.onAttach(handle);
			handedOff = true;
		} finally {
			if (!handedOff) closeClient(client);
		}
	};
	return {
		runPi: async () => {
			throw new Error("The experimental runtime does not execute legacy pi commands");
		},
		runServer,
		runClient,
		runAttach,
		runSessions,
		close: () => {
			for (const client of clients) client.dispose();
			clients.clear();
		},
	};
}
