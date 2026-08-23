import type { ForensicEvent, ForensicEventInput, ForensicRecorder } from "@earendil-works/pi-server";
import { InMemoryForensicRecorder } from "@earendil-works/pi-server";
import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-session-backend-sqlite-node";

interface EventRow {
	seq: number;
	value: string;
}

/** SQLite-backed bounded forensic recorder used by configured coding-agent daemons. */
export class SqliteForensicRecorder implements ForensicRecorder {
	readonly #databaseFactory: SqliteDatabaseFactory;
	readonly #databasePath: string;
	readonly #memory: InMemoryForensicRecorder;
	#databasePromise: Promise<SqliteDatabase> | undefined;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loaded = false;

	constructor(databaseFactory: SqliteDatabaseFactory, databasePath: string, options: { maxEvents?: number } = {}) {
		this.#databaseFactory = databaseFactory;
		this.#databasePath = databasePath;
		this.#memory = new InMemoryForensicRecorder(options);
	}

	record(input: ForensicEventInput): Promise<ForensicEvent> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const event = this.#memory.prepare(input);
			(await this.#database())
				.prepare("INSERT OR REPLACE INTO v2_diagnostics (seq, value) VALUES (?, ?)")
				.run(event.seq, JSON.stringify(event));
			this.#memory.commit(event);
			return event;
		});
	}

	async read(afterSeq = 0): Promise<ForensicEvent[]> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.read(afterSeq);
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
		for (const row of (await this.#database())
			.prepare("SELECT seq, value FROM v2_diagnostics ORDER BY seq")
			.all<EventRow>())
			this.#memory.restore(parseJson(row.value));
	}

	#database(): Promise<SqliteDatabase> {
		this.#databasePromise ??= this.#open();
		return this.#databasePromise;
	}

	async #open(): Promise<SqliteDatabase> {
		const database = await this.#databaseFactory.open(this.#databasePath);
		database.exec(
			"CREATE TABLE IF NOT EXISTS v2_diagnostics (seq INTEGER PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
		);
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

function parseJson(value: string): ForensicEvent {
	try {
		return JSON.parse(value) as ForensicEvent;
	} catch (error) {
		throw new Error("Invalid SQLite forensic event", { cause: error });
	}
}
