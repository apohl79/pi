import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "record"; readonly seq: number; readonly value: string }
	| { readonly command: "close" };
type WorkerRequest = { readonly id: number; readonly command: WorkerCommand };
type WorkerResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };
type EventRow = { readonly value: string };

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
		throw new Error("SQLite forensic worker requires a database path");
	return value.databasePath;
}

const port = parentPort;
if (port === null) throw new Error("SQLite forensic worker requires parentPort");
const database = new DatabaseSync(databasePath(workerData));
database.exec("CREATE TABLE IF NOT EXISTS v2_diagnostics (seq INTEGER PRIMARY KEY NOT NULL, value TEXT NOT NULL)");

function handle(command: WorkerCommand): unknown {
	if (command.command === "load")
		return (database.prepare("SELECT value FROM v2_diagnostics ORDER BY seq").all() as EventRow[]).map(
			(row) => row.value,
		);
	if (command.command === "record") {
		database
			.prepare("INSERT OR REPLACE INTO v2_diagnostics (seq, value) VALUES (?, ?)")
			.run(command.seq, command.value);
		return undefined;
	}
	database.close();
	return undefined;
}

port.on("message", (message: unknown) => {
	const response: WorkerResponse = (() => {
		if (!isWorkerRequest(message)) return { id: -1, error: "Invalid SQLite forensic worker request" };
		try {
			return { id: message.id, result: handle(message.command) };
		} catch (error) {
			return { id: message.id, error: error instanceof Error ? error.message : String(error) };
		}
	})();
	port.postMessage(response);
});
