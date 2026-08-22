import type { EventEnvelopeV2, OperationRecordV2 } from "@earendil-works/pi-protocol";
import { type V2OperationStore, validateV2EventEnvelope, validateV2OperationRecord } from "@earendil-works/pi-server";
import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-session-backend-sqlite-node";

interface OperationRow {
	operation_id: string;
	value: string;
}

interface EventRow {
	value: string;
}

/** SQLite-backed operation and event journal used by configured coding-agent daemons. */
export class SqliteV2OperationStore implements V2OperationStore {
	readonly #databaseFactory: SqliteDatabaseFactory;
	readonly #databasePath: string;
	#databasePromise: Promise<SqliteDatabase> | undefined;
	#pendingWrite: Promise<void> = Promise.resolve();

	constructor(databaseFactory: SqliteDatabaseFactory, databasePath: string) {
		this.#databaseFactory = databaseFactory;
		this.#databasePath = databasePath;
	}

	async load(): Promise<{ operations: readonly OperationRecordV2[]; events: readonly EventEnvelopeV2[] }> {
		const database = await this.#database();
		const operations = database
			.prepare("SELECT operation_id, value FROM v2_operations ORDER BY operation_id")
			.all<OperationRow>()
			.map((row) => {
				const value = parseJson(row.value, "operation record");
				validateV2OperationRecord(value);
				return value;
			});
		const events = database
			.prepare("SELECT value FROM v2_events ORDER BY rowid")
			.all<EventRow>()
			.map((row) => {
				const value = parseJson(row.value, "event record");
				validateV2EventEnvelope(value);
				return value;
			});
		return { operations, events };
	}

	putOperation(record: OperationRecordV2): Promise<void> {
		return this.#enqueue(async () => {
			const database = await this.#database();
			database
				.prepare(
					"INSERT INTO v2_operations (operation_id, value) VALUES (?, ?) " +
						"ON CONFLICT(operation_id) DO UPDATE SET value = excluded.value",
				)
				.run(record.operationId, JSON.stringify(record));
		});
	}

	appendEvent(event: EventEnvelopeV2): Promise<void> {
		return this.#enqueue(async () => {
			const database = await this.#database();
			database
				.prepare("INSERT OR REPLACE INTO v2_events (event_id, value) VALUES (?, ?)")
				.run(`${event.sessionId}:${event.seq}`, JSON.stringify(event));
		});
	}

	async close(): Promise<void> {
		await this.#pendingWrite;
		const database = await this.#databasePromise;
		if (database !== undefined) database.close();
		this.#databasePromise = undefined;
	}

	#database(): Promise<SqliteDatabase> {
		this.#databasePromise ??= this.#open();
		return this.#databasePromise;
	}

	async #open(): Promise<SqliteDatabase> {
		const database = await this.#databaseFactory.open(this.#databasePath);
		database.exec(
			"CREATE TABLE IF NOT EXISTS v2_operations (" +
				"operation_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)" +
				"; CREATE TABLE IF NOT EXISTS v2_events (" +
				"event_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
		);
		return database;
	}

	#enqueue(operation: () => Promise<void>): Promise<void> {
		const write = this.#pendingWrite.then(operation);
		this.#pendingWrite = write.catch(() => undefined);
		return write;
	}
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`Invalid SQLite ${label}`, { cause: error });
	}
}
