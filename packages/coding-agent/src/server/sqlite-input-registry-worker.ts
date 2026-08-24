import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "save"; readonly requestId: string; readonly value: string }
	| { readonly command: "consume"; readonly requestId: string }
	| { readonly command: "close" };
type WorkerRequest = { readonly id: number; readonly command: WorkerCommand };
type WorkerResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };
type InputRow = { readonly value: string };
type ConsumedRow = { readonly request_id: string };

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
		throw new Error("SQLite input worker requires a database path");
	return value.databasePath;
}

const port = parentPort;
if (port === null) throw new Error("SQLite input worker requires parentPort");
const database = new DatabaseSync(databasePath(workerData));
database.exec(
	"CREATE TABLE IF NOT EXISTS v2_inputs (request_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);" +
		"CREATE TABLE IF NOT EXISTS v2_input_consumed (request_id TEXT PRIMARY KEY NOT NULL)",
);

function handle(command: WorkerCommand): unknown {
	if (command.command === "load")
		return {
			requests: (database.prepare("SELECT value FROM v2_inputs ORDER BY rowid").all() as InputRow[]).map(
				(row) => row.value,
			),
			consumed: (
				database.prepare("SELECT request_id FROM v2_input_consumed ORDER BY rowid").all() as ConsumedRow[]
			).map((row) => row.request_id),
		};
	if (command.command === "save") {
		database
			.prepare(
				"INSERT INTO v2_inputs (request_id, value) VALUES (?, ?) ON CONFLICT(request_id) DO UPDATE SET value = excluded.value",
			)
			.run(command.requestId, command.value);
		return undefined;
	}
	if (command.command === "consume") {
		database.prepare("INSERT OR IGNORE INTO v2_input_consumed (request_id) VALUES (?)").run(command.requestId);
		return undefined;
	}
	database.close();
	return undefined;
}

port.on("message", (message: unknown) => {
	const response: WorkerResponse = (() => {
		if (!isWorkerRequest(message)) return { id: -1, error: "Invalid SQLite input worker request" };
		try {
			return { id: message.id, result: handle(message.command) };
		} catch (error) {
			return { id: message.id, error: error instanceof Error ? error.message : String(error) };
		}
	})();
	port.postMessage(response);
});
