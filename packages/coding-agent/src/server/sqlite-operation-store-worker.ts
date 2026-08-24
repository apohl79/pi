import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "putOperation"; readonly operationId: string; readonly value: string }
	| { readonly command: "appendEvent"; readonly eventId: string; readonly value: string }
	| { readonly command: "close" };

type WorkerRequest = {
	readonly id: number;
	readonly command: WorkerCommand;
};

type WorkerResponse = {
	readonly id: number;
	readonly result?: unknown;
	readonly error?: string;
};

type OperationRow = { readonly value: string };

function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (value === null || typeof value !== "object" || !("id" in value) || !("command" in value)) return false;
	return typeof value.id === "number" && value.command !== null && typeof value.command === "object";
}

function databasePath(value: unknown): string {
	if (
		value === null ||
		typeof value !== "object" ||
		!("databasePath" in value) ||
		typeof value.databasePath !== "string"
	)
		throw new Error("SQLite operation worker requires a database path");
	return value.databasePath;
}

const port = parentPort;
if (port === null) throw new Error("SQLite operation worker requires parentPort");
const database = new DatabaseSync(databasePath(workerData));
database.exec(
	"CREATE TABLE IF NOT EXISTS v2_operations (" +
		"operation_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)" +
		"; CREATE TABLE IF NOT EXISTS v2_events (" +
		"event_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
);

function handle(command: WorkerCommand): unknown {
	if (command.command === "load") {
		return {
			operations: (
				database.prepare("SELECT value FROM v2_operations ORDER BY operation_id").all() as OperationRow[]
			).map((row) => row.value),
			events: (database.prepare("SELECT value FROM v2_events ORDER BY rowid").all() as OperationRow[]).map(
				(row) => row.value,
			),
		};
	}
	if (command.command === "putOperation") {
		database
			.prepare(
				"INSERT INTO v2_operations (operation_id, value) VALUES (?, ?) " +
					"ON CONFLICT(operation_id) DO UPDATE SET value = excluded.value",
			)
			.run(command.operationId, command.value);
		return undefined;
	}
	if (command.command === "appendEvent") {
		database
			.prepare("INSERT OR REPLACE INTO v2_events (event_id, value) VALUES (?, ?)")
			.run(command.eventId, command.value);
		return undefined;
	}
	database.close();
	return undefined;
}

port.on("message", (message: unknown) => {
	const response: WorkerResponse = (() => {
		if (!isWorkerRequest(message)) return { id: -1, error: "Invalid SQLite operation worker request" };
		try {
			return { id: message.id, result: handle(message.command) };
		} catch (error) {
			return { id: message.id, error: error instanceof Error ? error.message : String(error) };
		}
	})();
	port.postMessage(response);
});
