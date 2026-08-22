import type { V2InputQuestion, V2InputRegistry, V2InputRequest } from "@earendil-works/pi-server";
import { InMemoryV2InputRegistry } from "@earendil-works/pi-server";
import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-session-backend-sqlite-node";

interface InputRow {
	request_id: string;
	value: string;
}

interface ConsumedRow {
	request_id: string;
}

/** SQLite-backed structured-input registry used by configured coding-agent daemons. */
export class SqliteV2InputRegistry implements V2InputRegistry {
	readonly #databaseFactory: SqliteDatabaseFactory;
	readonly #databasePath: string;
	readonly #memory = new InMemoryV2InputRegistry();
	#databasePromise: Promise<SqliteDatabase> | undefined;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loaded = false;
	readonly #responded = new Map<string, string[]>();
	readonly #consumed = new Set<string>();
	readonly #requests = new Map<string, V2InputRequest>();

	constructor(databaseFactory: SqliteDatabaseFactory, databasePath: string) {
		this.#databaseFactory = databaseFactory;
		this.#databasePath = databasePath;
	}

	create(
		sessionId: string,
		questions: readonly V2InputQuestion[],
		autoResolutionMs?: number,
	): Promise<V2InputRequest> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const request = await this.#memory.create(sessionId, questions, autoResolutionMs);
			await this.#save(request);
			this.#requests.set(request.id, request);
			return request;
		});
	}

	async read(requestId: string): Promise<V2InputRequest> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.read(requestId);
	}

	respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest> {
		return this.#mutate(() => this.#memory.respond(requestId, answers));
	}

	cancel(requestId: string): Promise<V2InputRequest> {
		return this.#mutate(() => this.#memory.cancel(requestId));
	}

	async wait(requestId: string): Promise<V2InputRequest> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.wait(requestId);
	}

	async pendingForSession(sessionId: string): Promise<string | undefined> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#memory.pendingForSession(sessionId);
	}

	takeRespondedForSession(sessionId: string): Promise<Readonly<Record<string, string>> | undefined> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const requestId = [...(this.#responded.get(sessionId) ?? [])].reverse().find((id) => !this.#consumed.has(id));
			if (requestId === undefined) return undefined;
			const request = this.#requests.get(requestId);
			if (request?.status !== "responded") return undefined;
			this.#consumed.add(requestId);
			(await this.#database())
				.prepare("INSERT OR IGNORE INTO v2_input_consumed (request_id) VALUES (?)")
				.run(requestId);
			return structuredClone(request.answers ?? {});
		});
	}

	async close(): Promise<void> {
		await this.#pendingWrite;
		const database = await this.#databasePromise;
		if (database !== undefined) database.close();
		this.#databasePromise = undefined;
		this.#loaded = false;
	}

	async #mutate(operation: () => Promise<V2InputRequest>): Promise<V2InputRequest> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const request = await operation();
			await this.#save(request);
			this.#requests.set(request.id, request);
			if (request.status === "responded") {
				const ids = this.#responded.get(request.sessionId) ?? [];
				if (!ids.includes(request.id)) ids.push(request.id);
				this.#responded.set(request.sessionId, ids);
			}
			return request;
		});
	}

	async #save(request: V2InputRequest): Promise<void> {
		(await this.#database())
			.prepare(
				"INSERT INTO v2_inputs (request_id, value) VALUES (?, ?) " +
					"ON CONFLICT(request_id) DO UPDATE SET value = excluded.value",
			)
			.run(request.id, JSON.stringify(request));
	}

	async #ensureLoaded(): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		const database = await this.#database();
		const requests = database.prepare("SELECT request_id, value FROM v2_inputs ORDER BY rowid").all<InputRow>();
		for (const row of requests) {
			const request = parseJson(row.value);
			this.#memory.restore(request);
			this.#requests.set(request.id, request);
			if (request.status === "responded") {
				const ids = this.#responded.get(request.sessionId) ?? [];
				ids.push(request.id);
				this.#responded.set(request.sessionId, ids);
			}
		}
		for (const row of database
			.prepare("SELECT request_id FROM v2_input_consumed ORDER BY rowid")
			.all<ConsumedRow>()) {
			const request = parseJson(
				requests.find((candidate) => candidate.request_id === row.request_id)?.value ?? "{}",
			);
			if (request.status === "responded") {
				this.#consumed.add(request.id);
			}
		}
	}

	#database(): Promise<SqliteDatabase> {
		this.#databasePromise ??= this.#open();
		return this.#databasePromise;
	}

	async #open(): Promise<SqliteDatabase> {
		const database = await this.#databaseFactory.open(this.#databasePath);
		database.exec(
			"CREATE TABLE IF NOT EXISTS v2_inputs (request_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);" +
				"CREATE TABLE IF NOT EXISTS v2_input_consumed (request_id TEXT PRIMARY KEY NOT NULL)",
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

function parseJson(value: string): V2InputRequest {
	try {
		return JSON.parse(value) as V2InputRequest;
	} catch (error) {
		throw new Error("Invalid SQLite input request", { cause: error });
	}
}
