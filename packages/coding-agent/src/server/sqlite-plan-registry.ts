import type { PlanItem, PlanSnapshot } from "@earendil-works/pi-protocol";
import type { V2PlanRegistry } from "@earendil-works/pi-server";
import { InMemoryV2PlanRegistry, validateV2Plan } from "@earendil-works/pi-server";
import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-session-backend-sqlite-node";

interface PlanRow {
	session_id: string;
	value: string | null;
}

/** SQLite-backed plan snapshot registry used by configured coding-agent daemons. */
export class SqliteV2PlanRegistry implements V2PlanRegistry {
	readonly #databaseFactory: SqliteDatabaseFactory;
	readonly #databasePath: string;
	readonly #memory = new InMemoryV2PlanRegistry();
	#databasePromise: Promise<SqliteDatabase> | undefined;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loaded = false;

	constructor(databaseFactory: SqliteDatabaseFactory, databasePath: string) {
		this.#databaseFactory = databaseFactory;
		this.#databasePath = databasePath;
	}

	async read(sessionId: string): Promise<PlanSnapshot | undefined> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.read(sessionId);
	}

	update(sessionId: string, input: { readonly items: readonly PlanItem[]; readonly version?: number }) {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const current = await this.#memory.read(sessionId);
			const plan = validateV2Plan(current, input);
			(await this.#database())
				.prepare(
					"INSERT INTO v2_plans (session_id, value) VALUES (?, ?) " +
						"ON CONFLICT(session_id) DO UPDATE SET value = excluded.value",
				)
				.run(sessionId, JSON.stringify(plan));
			await this.#memory.update(sessionId, input);
			return plan;
		});
	}

	clear(sessionId: string): Promise<void> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			(await this.#database()).prepare("DELETE FROM v2_plans WHERE session_id = ?").run(sessionId);
			await this.#memory.clear(sessionId);
		});
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
			.prepare("SELECT session_id, value FROM v2_plans ORDER BY session_id")
			.all<PlanRow>())
			if (row.value !== null) await this.#memory.update(row.session_id, parseJson(row.value));
	}

	#database(): Promise<SqliteDatabase> {
		this.#databasePromise ??= this.#open();
		return this.#databasePromise;
	}

	async #open(): Promise<SqliteDatabase> {
		const database = await this.#databaseFactory.open(this.#databasePath);
		database.exec("CREATE TABLE IF NOT EXISTS v2_plans (session_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
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

function parseJson(value: string): { readonly items: readonly PlanItem[]; readonly version?: number } {
	try {
		return JSON.parse(value) as { readonly items: readonly PlanItem[]; readonly version?: number };
	} catch (error) {
		throw new Error("Invalid SQLite plan snapshot", { cause: error });
	}
}
