import { Worker } from "node:worker_threads";
import type { EventEnvelopeV2, OperationRecordV2 } from "@earendil-works/pi-protocol";
import { type V2OperationStore, validateV2EventEnvelope, validateV2OperationRecord } from "@earendil-works/pi-server";

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "putOperation"; readonly operationId: string; readonly value: string }
	| { readonly command: "appendEvent"; readonly eventId: string; readonly value: string }
	| { readonly command: "close" };

type WorkerResponse = {
	readonly id: number;
	readonly result?: unknown;
	readonly error?: string;
};

type LoadedJournal = {
	readonly operations: readonly string[];
	readonly events: readonly string[];
};

function isWorkerResponse(value: unknown): value is WorkerResponse {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "number";
}

/** SQLite-backed operation and event journal used by configured coding-agent daemons. */
export class SqliteV2OperationStore implements V2OperationStore {
	readonly #databasePath: string;
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#worker: Worker | undefined;
	#nextRequestId = 1;
	#closed = false;

	constructor(databasePath: string) {
		this.#databasePath = databasePath;
	}

	async load(): Promise<{ operations: readonly OperationRecordV2[]; events: readonly EventEnvelopeV2[] }> {
		const loaded = await this.#request<LoadedJournal>({ command: "load" });
		return {
			operations: loaded.operations.map((value) => {
				const record = parseJson(value, "operation record");
				validateV2OperationRecord(record);
				return record;
			}),
			events: loaded.events.map((value) => {
				const event = parseJson(value, "event record");
				validateV2EventEnvelope(event);
				return event;
			}),
		};
	}

	putOperation(record: OperationRecordV2): Promise<void> {
		return this.#request({
			command: "putOperation",
			operationId: record.operationId,
			value: JSON.stringify(record),
		});
	}

	appendEvent(event: EventEnvelopeV2): Promise<void> {
		return this.#request({
			command: "appendEvent",
			eventId: `${event.sessionId}:${event.seq}`,
			value: JSON.stringify(event),
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const worker = this.#worker;
		if (worker === undefined) return;
		try {
			await this.#request({ command: "close" }, true);
		} finally {
			await worker.terminate();
			this.#worker = undefined;
		}
	}

	#request<T>(command: WorkerCommand, closing = false): Promise<T> {
		if (this.#closed && !closing) return Promise.reject(new Error("SQLite operation store is closed"));
		const worker = this.#worker ?? this.#createWorker();
		const id = this.#nextRequestId;
		this.#nextRequestId += 1;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			worker.postMessage({ id, command });
		});
	}

	#createWorker(): Worker {
		if (typeof process.versions.bun === "string") {
			const worker = new Worker("./src/server/sqlite-operation-store-worker.ts", {
				workerData: { databasePath: this.#databasePath },
			});
			return this.#observeWorker(worker);
		}
		const workerUrl = new URL(
			import.meta.url.endsWith(".ts") ? "./sqlite-operation-store-worker.ts" : "./sqlite-operation-store-worker.js",
			import.meta.url,
		);
		const worker = new Worker(workerUrl, { workerData: { databasePath: this.#databasePath } });
		return this.#observeWorker(worker);
	}

	#observeWorker(worker: Worker): Worker {
		worker.on("message", (message: unknown) => this.#handleResponse(message));
		worker.once("error", (error) => this.#failPending(error));
		worker.once("exit", (code) => {
			if (!this.#closed && code !== 0)
				this.#failPending(new Error(`SQLite operation worker exited with code ${code}`));
			if (this.#worker === worker) this.#worker = undefined;
		});
		this.#worker = worker;
		return worker;
	}

	#handleResponse(message: unknown): void {
		if (!isWorkerResponse(message)) {
			this.#failPending(new Error("Invalid SQLite operation worker response"));
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
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`Invalid SQLite ${label}`, { cause: error });
	}
}
