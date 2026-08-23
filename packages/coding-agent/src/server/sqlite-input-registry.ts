import type {
	V2InputChangeListener,
	V2InputQuestion,
	V2InputRegistry,
	V2InputRequest,
} from "@earendil-works/pi-server";
import {
	cancelV2InputRequest,
	createV2InputRequest,
	InMemoryV2InputRegistry,
	respondV2InputRequest,
} from "@earendil-works/pi-server";
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
	readonly #listeners = new Set<V2InputChangeListener>();

	constructor(databaseFactory: SqliteDatabaseFactory, databasePath: string) {
		this.#databaseFactory = databaseFactory;
		this.#databasePath = databasePath;
	}

	onChange(listener: V2InputChangeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	create(
		sessionId: string,
		questions: readonly V2InputQuestion[],
		autoResolutionMs?: number,
	): Promise<V2InputRequest> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const request = createV2InputRequest(sessionId, questions, autoResolutionMs);
			await this.#save(request);
			this.#memory.restore(request);
			this.#requests.set(request.id, request);
			this.#notify(request);
			return request;
		});
	}

	async read(requestId: string): Promise<V2InputRequest> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#persistExpired(await this.#memory.read(requestId));
	}

	respond(requestId: string, answers: Readonly<Record<string, string>>): Promise<V2InputRequest> {
		return this.#mutate(async () => {
			const next = respondV2InputRequest(await this.#memory.read(requestId), answers);
			return { durable: next, commit: () => this.#memory.respond(requestId, answers) };
		}).then((request) => {
			this.#notify(request);
			return request;
		});
	}

	cancel(requestId: string): Promise<V2InputRequest> {
		return this.#mutate(async () => {
			const next = cancelV2InputRequest(await this.#memory.read(requestId));
			return { durable: next, commit: () => this.#memory.cancel(requestId) };
		}).then((request) => {
			this.#notify(request);
			return request;
		});
	}

	#notify(request: V2InputRequest): void {
		for (const listener of this.#listeners) listener(structuredClone(request));
	}

	async wait(requestId: string): Promise<V2InputRequest> {
		await this.#pendingWrite;
		await this.#ensureLoaded();
		return this.#persistExpired(await this.#memory.wait(requestId));
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
			(await this.#database())
				.prepare("INSERT OR IGNORE INTO v2_input_consumed (request_id) VALUES (?)")
				.run(requestId);
			this.#consumed.add(requestId);
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

	async #mutate(
		operation: () => Promise<{ durable: V2InputRequest; commit: () => Promise<V2InputRequest> }>,
	): Promise<V2InputRequest> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const transition = await operation();
			await this.#save(transition.durable);
			const request = await transition.commit();
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
			const request = expireIfDue(parseJson(row.value));
			if (request.status === "expired") {
				database
					.prepare("UPDATE v2_inputs SET value = ? WHERE request_id = ?")
					.run(JSON.stringify(request), request.id);
			}
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

	#persistExpired(request: V2InputRequest): Promise<V2InputRequest> {
		if (request.status !== "expired") return Promise.resolve(request);
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const current = this.#requests.get(request.id);
			if (current?.status !== "expired") {
				await this.#save(request);
				this.#requests.set(request.id, request);
			}
			return request;
		});
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

function expireIfDue(request: V2InputRequest): V2InputRequest {
	return request.status === "pending" && request.deadlineAt !== undefined && request.deadlineAt <= Date.now()
		? { ...request, status: "expired", answers: {} }
		: request;
}
