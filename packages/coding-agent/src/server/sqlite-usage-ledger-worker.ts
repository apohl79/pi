import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "record"; readonly responseId: string; readonly value: string }
	| { readonly command: "close" };
type WorkerRequest = { readonly id: number; readonly command: WorkerCommand };
type WorkerResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };
type UsageRow = { readonly value: string };

function isWorkerRequest(value: unknown): value is WorkerRequest {
	return (
		value !== null && typeof value === "object" && "id" in value && "command" in value && typeof value.id === "number"
	);
}

function databasePath(value: unknown): string {
	if (
		value === null ||
		typeof value !== "object" ||
		!("databasePath" in value) ||
		typeof value.databasePath !== "string"
	)
		throw new Error("SQLite usage worker requires a database path");
	return value.databasePath;
}

const port = parentPort;
if (port === null) throw new Error("SQLite usage worker requires parentPort");
const database = new DatabaseSync(databasePath(workerData));
database.exec("CREATE TABLE IF NOT EXISTS v2_usage (response_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");

function handle(command: WorkerCommand): unknown {
	if (command.command === "load")
		return (database.prepare("SELECT value FROM v2_usage ORDER BY rowid").all() as UsageRow[]).map(
			(row) => row.value,
		);
	if (command.command === "record") {
		database
			.prepare(
				"INSERT INTO v2_usage (response_id, value) VALUES (?, ?) ON CONFLICT(response_id) DO UPDATE SET value = excluded.value",
			)
			.run(command.responseId, command.value);
		return undefined;
	}
	database.close();
	return undefined;
}

port.on("message", (message: unknown) => {
	const response: WorkerResponse = (() => {
		if (!isWorkerRequest(message)) return { id: -1, error: "Invalid SQLite usage worker request" };
		try {
			return { id: message.id, result: handle(message.command) };
		} catch (error) {
			return { id: message.id, error: error instanceof Error ? error.message : String(error) };
		}
	})();
	port.postMessage(response);
});
