import type { V2UsageFilter, V2UsageLedger, V2UsageLedgerEntry } from "@earendil-works/pi-server";
import { InMemoryV2UsageLedger } from "@earendil-works/pi-server";
import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-session-backend-sqlite-node";

interface UsageRow {
	response_id: string;
	value: string;
}

/** SQLite-backed usage ledger used by configured coding-agent daemons. */
export class SqliteV2UsageLedger implements V2UsageLedger {
	readonly #databaseFactory: SqliteDatabaseFactory;
	readonly #databasePath: string;
	readonly #memory = new InMemoryV2UsageLedger();
	#databasePromise: Promise<SqliteDatabase> | undefined;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loaded = false;

	constructor(databaseFactory: SqliteDatabaseFactory, databasePath: string) {
		this.#databaseFactory = databaseFactory;
		this.#databasePath = databasePath;
	}

	record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const recorded = await this.#memory.record(entry);
			const database = await this.#database();
			database
				.prepare(
					"INSERT INTO v2_usage (response_id, value) VALUES (?, ?) " +
						"ON CONFLICT(response_id) DO UPDATE SET value = excluded.value",
				)
				.run(recorded.responseId, JSON.stringify(recorded));
			return recorded;
		});
	}

	async read(filter: V2UsageFilter = {}): Promise<readonly V2UsageLedgerEntry[]> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.read(filter);
	}

	async aggregate(filter: V2UsageFilter = {}) {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.aggregate(filter);
	}

	async close(): Promise<void> {
		await this.#pendingWrite;
		const database = await this.#databasePromise;
		if (database !== undefined) database.close();
		this.#databasePromise = undefined;
		this.#loaded = false;
	}

	async #ensureLoaded(): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		const database = await this.#database();
		for (const row of database.prepare("SELECT response_id, value FROM v2_usage ORDER BY rowid").all<UsageRow>())
			await this.#memory.record(parseJson(row.value));
	}

	#database(): Promise<SqliteDatabase> {
		this.#databasePromise ??= this.#open();
		return this.#databasePromise;
	}

	async #open(): Promise<SqliteDatabase> {
		const database = await this.#databaseFactory.open(this.#databasePath);
		database.exec("CREATE TABLE IF NOT EXISTS v2_usage (response_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
		return database;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const write = this.#pendingWrite.then(operation);
		this.#pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return write;
	}
}

function parseJson(value: string): V2UsageLedgerEntry {
	try {
		return JSON.parse(value) as V2UsageLedgerEntry;
	} catch (error) {
		throw new Error("Invalid SQLite usage ledger entry", { cause: error });
	}
}
