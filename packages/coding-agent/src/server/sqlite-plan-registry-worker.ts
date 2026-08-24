import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type Command =
	| { command: "load" }
	| { command: "update"; sessionId: string; value: string }
	| { command: "clear"; sessionId: string }
	| { command: "close" };
type Request = { id: number; command: Command };
type Response = { id: number; result?: unknown; error?: string };
type Row = { session_id: string; value: string };
const port = parentPort;
if (port === null || workerData === null || typeof workerData.path !== "string")
	throw new Error("SQLite plan worker requires parentPort and path");
const db = new DatabaseSync(workerData.path);
db.exec("CREATE TABLE IF NOT EXISTS v2_plans (session_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
function request(value: unknown): value is Request {
	return (
		value !== null && typeof value === "object" && "id" in value && "command" in value && typeof value.id === "number"
	);
}
function run(command: Command): unknown {
	if (command.command === "load")
		return (db.prepare("SELECT session_id, value FROM v2_plans ORDER BY session_id").all() as Row[]).map((row) => ({
			sessionId: row.session_id,
			value: row.value,
		}));
	if (command.command === "update") {
		db.prepare(
			"INSERT INTO v2_plans (session_id, value) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET value = excluded.value",
		).run(command.sessionId, command.value);
		return;
	}
	if (command.command === "clear") {
		db.prepare("DELETE FROM v2_plans WHERE session_id = ?").run(command.sessionId);
		return;
	}
	db.close();
}
port.on("message", (value: unknown) => {
	const response: Response = !request(value)
		? { id: -1, error: "Invalid SQLite plan worker request" }
		: (() => {
				try {
					return { id: value.id, result: run(value.command) };
				} catch (error) {
					return { id: value.id, error: error instanceof Error ? error.message : String(error) };
				}
			})();
	port.postMessage(response);
});
