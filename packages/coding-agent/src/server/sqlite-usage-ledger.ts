import { Worker } from "node:worker_threads";
import type { V2UsageFilter, V2UsageLedger, V2UsageLedgerEntry } from "@earendil-works/pi-server";
import { InMemoryV2UsageLedger, validateV2UsageEntry } from "@earendil-works/pi-server";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "record"; readonly responseId: string; readonly value: string }
	| { readonly command: "close" };

type WorkerResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };

function isWorkerResponse(value: unknown): value is WorkerResponse {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "number";
}

/** SQLite-backed usage ledger used by configured coding-agent daemons. */
export class SqliteV2UsageLedger implements V2UsageLedger {
	readonly #databasePath: string;
	readonly #memory = new InMemoryV2UsageLedger();
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#worker: Worker | undefined;
	#nextRequestId = 1;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loadPromise: Promise<void> | undefined;
	#loaded = false;
	#closed = false;

	constructor(databasePath: string) {
		this.#databasePath = databasePath;
	}

	record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const recorded = validateV2UsageEntry(entry);
			await this.#request({ command: "record", responseId: recorded.responseId, value: JSON.stringify(recorded) });
			await this.#memory.record(recorded);
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
		if (this.#closed) return;
		await this.#pendingWrite;
		this.#closed = true;
		const worker = this.#worker;
		if (worker !== undefined) {
			try {
				await this.#request({ command: "close" }, true);
			} finally {
				await worker.terminate();
				this.#worker = undefined;
			}
		}
		this.#loaded = false;
	}

	async #ensureLoaded(): Promise<void> {
		if (this.#loaded) return;
		const load = this.#loadPromise ?? this.#load();
		this.#loadPromise = load;
		try {
			await load;
		} finally {
			if (this.#loadPromise === load) this.#loadPromise = undefined;
		}
	}

	async #load(): Promise<void> {
		const values = await this.#request<readonly string[]>({ command: "load" });
		for (const value of values) await this.#memory.record(parseJson(value));
		this.#loaded = true;
	}

	#request<T>(command: WorkerCommand, closing = false): Promise<T> {
		if (this.#closed && !closing) return Promise.reject(new Error("SQLite usage ledger is closed"));
		const worker = this.#worker ?? this.#createWorker();
		const id = this.#nextRequestId;
		this.#nextRequestId += 1;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			worker.postMessage({ id, command });
		});
	}

	#createWorker(): Worker {
		const worker =
			typeof process.versions.bun === "string"
				? new Worker("./src/server/sqlite-usage-ledger-worker.ts", {
						workerData: { databasePath: this.#databasePath },
					})
				: new Worker(
						new URL(
							import.meta.url.endsWith(".ts")
								? "./sqlite-usage-ledger-worker.ts"
								: "./sqlite-usage-ledger-worker.js",
							import.meta.url,
						),
						{ workerData: { databasePath: this.#databasePath } },
					);
		worker.on("message", (message: unknown) => this.#handleResponse(message));
		worker.once("error", (error) => this.#failPending(error));
		worker.once("exit", (code) => {
			if (!this.#closed && code !== 0) this.#failPending(new Error(`SQLite usage worker exited with code ${code}`));
			if (this.#worker === worker) this.#worker = undefined;
		});
		this.#worker = worker;
		return worker;
	}

	#handleResponse(message: unknown): void {
		if (!isWorkerResponse(message)) {
			this.#failPending(new Error("Invalid SQLite usage worker response"));
			return;
		}
		const request = this.#pending.get(message.id);
		if (request === undefined) return;
		this.#pending.delete(message.id);
		if (message.error !== undefined) request.reject(new Error(message.error));
		else request.resolve(message.result);
	}

	#failPending(error: Error): void {
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
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
