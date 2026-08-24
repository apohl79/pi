import { parentPort, workerData } from "node:worker_threads";
import type { SessionErrorCode } from "@earendil-works/pi-agent-core";
import { type Session, SessionError } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	createNodeSqliteFactory,
	type SqliteSessionMetadata,
	SqliteSessionRepository,
	type SqliteWriterLeaseOptions,
} from "@earendil-works/pi-session-backend-sqlite-node";

type RepositoryCommand =
	| "create"
	| "open"
	| "list"
	| "inspect"
	| "verifyReopen"
	| "repairBranchCache"
	| "repairDerivedIndexes"
	| "backup"
	| "delete"
	| "fork"
	| "close";
type StorageCommand =
	| "getMetadata"
	| "getLanes"
	| "createLane"
	| "moveLane"
	| "appendEntry"
	| "appendRecord"
	| "appendRecords"
	| "appendTransaction"
	| "getRegister"
	| "appendAtomicTransaction"
	| "getEntry"
	| "findEntries"
	| "findEntriesOnBranch"
	| "findRecords"
	| "findOpenOperations"
	| "getLog"
	| "getName"
	| "setName"
	| "getLabel"
	| "setLabel"
	| "getStats";
type WorkerCommand =
	| { readonly scope: "repository"; readonly command: RepositoryCommand; readonly args: readonly unknown[] }
	| {
			readonly scope: "storage";
			readonly sessionId: string;
			readonly command: StorageCommand;
			readonly args: readonly unknown[];
	  };
type WorkerRequest = { readonly id: number; readonly command: WorkerCommand };
type WorkerResponse = {
	readonly id: number;
	readonly result?: unknown;
	readonly error?: { readonly message: string; readonly name: string; readonly code?: SessionErrorCode };
};
type WorkerOptions = {
	readonly databasePath: string;
	readonly cwd: string;
	readonly writerLease?: SqliteWriterLeaseOptions;
};

function isWorkerRequest(value: unknown): value is WorkerRequest {
	return (
		value !== null && typeof value === "object" && "id" in value && "command" in value && typeof value.id === "number"
	);
}

function options(value: unknown): WorkerOptions {
	if (
		value === null ||
		typeof value !== "object" ||
		!("databasePath" in value) ||
		!("cwd" in value) ||
		typeof value.databasePath !== "string" ||
		typeof value.cwd !== "string"
	) {
		throw new Error("SQLite session worker requires databasePath and cwd");
	}
	return value as WorkerOptions;
}

const port = parentPort;
if (port === null) throw new Error("SQLite session worker requires parentPort");
const workerOptions = options(workerData);
const repository = new SqliteSessionRepository({
	env: new NodeExecutionEnv({ cwd: workerOptions.cwd }),
	sqlite: createNodeSqliteFactory(),
	databasePath: workerOptions.databasePath,
	...(workerOptions.writerLease === undefined ? {} : { writerLease: workerOptions.writerLease }),
});
const sessions = new Map<string, Session<SqliteSessionMetadata>>();
const storageCommands = new Set<StorageCommand>([
	"getMetadata",
	"getLanes",
	"createLane",
	"moveLane",
	"appendEntry",
	"appendRecord",
	"appendRecords",
	"appendTransaction",
	"getRegister",
	"appendAtomicTransaction",
	"getEntry",
	"findEntries",
	"findEntriesOnBranch",
	"findRecords",
	"findOpenOperations",
	"getLog",
	"getName",
	"setName",
	"getLabel",
	"setLabel",
	"getStats",
]);

async function remember(session: Session<SqliteSessionMetadata>): Promise<SqliteSessionMetadata> {
	const metadata = await session.getMetadata();
	sessions.set(metadata.id, session);
	return metadata;
}

async function invokeRepository(command: RepositoryCommand, args: readonly unknown[]): Promise<unknown> {
	switch (command) {
		case "create":
			return remember(await repository.create(args[0] as Parameters<typeof repository.create>[0]));
		case "open":
			return remember(await repository.open(args[0] as SqliteSessionMetadata));
		case "list":
			return repository.list(args[0] as Parameters<typeof repository.list>[0]);
		case "inspect":
			return repository.inspect();
		case "verifyReopen":
			return repository.verifyReopen();
		case "repairBranchCache":
			return repository.repairBranchCache(args[0] as SqliteSessionMetadata);
		case "repairDerivedIndexes":
			return repository.repairDerivedIndexes();
		case "backup":
			return repository.backup(args[0] as string);
		case "delete": {
			const metadata = args[0] as SqliteSessionMetadata;
			sessions.delete(metadata.id);
			return repository.delete(metadata);
		}
		case "fork":
			return remember(
				await repository.fork(args[0] as SqliteSessionMetadata, args[1] as Parameters<typeof repository.fork>[1]),
			);
		case "close":
			sessions.clear();
			return repository.close();
	}
}

async function invokeStorage(sessionId: string, command: StorageCommand, args: readonly unknown[]): Promise<unknown> {
	const session = sessions.get(sessionId);
	if (session === undefined) throw new Error(`SQLite session ${sessionId} is not open in the worker`);
	if (!storageCommands.has(command)) throw new Error(`Unsupported SQLite session storage command: ${command}`);
	const candidate = Reflect.get(session, command);
	if (typeof candidate !== "function") throw new Error(`SQLite session method is unavailable: ${command}`);
	return Reflect.apply(candidate, session, args);
}

port.on("message", (message: unknown) => {
	void (async () => {
		if (!isWorkerRequest(message))
			return port.postMessage({
				id: -1,
				error: { name: "Error", message: "Invalid SQLite session worker request" },
			} satisfies WorkerResponse);
		try {
			const result =
				message.command.scope === "repository"
					? await invokeRepository(message.command.command, message.command.args)
					: await invokeStorage(message.command.sessionId, message.command.command, message.command.args);
			port.postMessage({ id: message.id, result } satisfies WorkerResponse);
		} catch (error) {
			const sessionError = error instanceof SessionError ? error : undefined;
			port.postMessage({
				id: message.id,
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
					...(sessionError === undefined ? {} : { code: sessionError.code }),
				},
			} satisfies WorkerResponse);
		}
	})();
});
