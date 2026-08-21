import { readFile, writeFile } from "node:fs/promises";
import type { PiClientV2, PiSessionV2Handle } from "@earendil-works/pi-client";
import type { CommandV2, JsonValue } from "@earendil-works/pi-protocol";
import type { ExperimentalCliContext } from "./cli.ts";
import type { AttachCommand } from "./commands/attach.ts";
import type { ClientCommand } from "./commands/client.ts";
import type { DiagnosticsCommand } from "./commands/diagnostics.ts";
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
	createClient(address: TransportAddress): PiClientV2;
	write(value: unknown): void;
	onAttach?(handle: PiSessionV2Handle): void | Promise<void>;
};

function resultOf(response: Awaited<ReturnType<PiClientV2["request"]>>): Record<string, unknown> {
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	if (
		!("result" in response) ||
		typeof response.result !== "object" ||
		response.result === null ||
		Array.isArray(response.result)
	)
		throw new Error("Expected a command result");
	return response.result as Record<string, unknown>;
}

export type ExperimentalCliRuntime = ExperimentalCliContext & {
	close(): void;
};

export function createExperimentalCliRuntime(options: ExperimentalCliRuntimeOptions): ExperimentalCliRuntime {
	const clients = new Set<PiClientV2>();
	const connect = (address: TransportAddress): PiClientV2 => {
		const client = options.createClient(address);
		clients.add(client);
		return client;
	};
	const addressFor = (address: TransportAddress | undefined): TransportAddress => address ?? options.defaultConnect;
	const closeClient = (client: PiClientV2): void => {
		clients.delete(client);
		client.dispose();
	};
	const runServer = async (command: ServerCommand): Promise<void> => {
		const result =
			command.action === "stop"
				? await options.daemon.stop()
				: command.action === "status"
					? options.daemon.status()
					: await options.daemon.start(command.socket);
		options.write(result);
	};
	const runClient = async (command: ClientCommand): Promise<void> => {
		const client = connect(addressFor(command.connect));
		try {
			const snapshot = await client.connect();
			options.write(snapshot);
		} finally {
			closeClient(client);
		}
	};
	const runSessions = async (command: SessionsCommand): Promise<void> => {
		const client = connect(addressFor(command.connect));
		try {
			await client.connect();
			options.write(await client.listSessions());
		} finally {
			closeClient(client);
		}
	};
	const runDiagnostics = async (command: DiagnosticsCommand): Promise<void> => {
		const client = connect(addressFor(command.connect));
		try {
			await client.connect();
			if (command.action === "verify" && command.bundle !== undefined) {
				const bundle = JSON.parse(await readFile(command.bundle, "utf8")) as JsonValue;
				options.write(resultOf(await client.request({ command: "diagnostics/verify", payload: { bundle } })));
				return;
			}
			const protocolCommand =
				command.action === "tail" || command.action === "timeline"
					? "diagnostics/timeline"
					: `diagnostics/${command.action}`;
			const payload = {
				...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
				...(command.operationId === undefined ? {} : { operationId: command.operationId }),
				...(command.afterSeq === undefined ? {} : { afterSeq: command.afterSeq }),
			};
			const result = resultOf(await client.request({ command: protocolCommand as CommandV2["command"], payload }));
			if (command.action === "export" && command.output !== undefined) {
				await writeFile(command.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
			}
			options.write(result);
		} finally {
			closeClient(client);
		}
	};
	const runAttach = async (command: AttachCommand): Promise<void> => {
		if (command.sessionId === undefined) throw new Error("attach requires a session id");
		const client = connect(addressFor(command.connect));
		await client.connect();
		const handle = await client.openSession(command.sessionId);
		if (options.onAttach === undefined) {
			options.write(await handle.read());
			closeClient(client);
			return;
		}
		await options.onAttach(handle);
	};
	return {
		runPi: async () => {
			throw new Error("The experimental runtime does not execute legacy pi commands");
		},
		runServer,
		runClient,
		runAttach,
		runSessions,
		runDiagnostics,
		close: () => {
			for (const client of clients) client.dispose();
			clients.clear();
		},
	};
}
