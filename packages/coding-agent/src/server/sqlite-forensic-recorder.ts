import { Worker } from "node:worker_threads";
import type { ForensicEvent, ForensicEventInput, ForensicRecorder } from "@earendil-works/pi-server";
import { InMemoryForensicRecorder } from "@earendil-works/pi-server";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "record"; readonly seq: number; readonly value: string }
	| { readonly command: "close" };
type WorkerResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };

function isWorkerResponse(value: unknown): value is WorkerResponse {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "number";
}

/** SQLite-backed bounded forensic recorder used by configured coding-agent daemons. */
export class SqliteForensicRecorder implements ForensicRecorder {
	readonly #databasePath: string;
	readonly #memory: InMemoryForensicRecorder;
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#worker: Worker | undefined;
	#nextRequestId = 1;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loadPromise: Promise<void> | undefined;
	#loaded = false;
	#closed = false;

	constructor(databasePath: string, options: { maxEvents?: number } = {}) {
		this.#databasePath = databasePath;
		this.#memory = new InMemoryForensicRecorder(options);
	}

	record(input: ForensicEventInput): Promise<ForensicEvent> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const event = this.#memory.prepare(input);
			await this.#request({ command: "record", seq: event.seq, value: JSON.stringify(event) });
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
		for (const value of values) this.#memory.restore(parseJson(value));
		this.#loaded = true;
	}

	#request<T>(command: WorkerCommand, closing = false): Promise<T> {
		if (this.#closed && !closing) return Promise.reject(new Error("SQLite forensic recorder is closed"));
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
				? new Worker("./src/server/sqlite-forensic-recorder-worker.ts", {
						workerData: { databasePath: this.#databasePath },
					})
				: new Worker(
						new URL(
							import.meta.url.endsWith(".ts")
								? "./sqlite-forensic-recorder-worker.ts"
								: "./sqlite-forensic-recorder-worker.js",
							import.meta.url,
						),
						{ workerData: { databasePath: this.#databasePath } },
					);
		worker.on("message", (message: unknown) => this.#handleResponse(message));
		worker.once("error", (error) => this.#failPending(error));
		worker.once("exit", (code) => {
			if (!this.#closed && code !== 0)
				this.#failPending(new Error(`SQLite forensic worker exited with code ${code}`));
			if (this.#worker === worker) this.#worker = undefined;
		});
		this.#worker = worker;
		return worker;
	}

	#handleResponse(message: unknown): void {
		if (!isWorkerResponse(message)) {
			this.#failPending(new Error("Invalid SQLite forensic worker response"));
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

function parseJson(value: string): ForensicEvent {
	try {
		return JSON.parse(value) as ForensicEvent;
	} catch (error) {
		throw new Error("Invalid SQLite forensic event", { cause: error });
	}
}
