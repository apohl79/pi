import { Worker } from "node:worker_threads";
import type { PlanItem, PlanSnapshot } from "@earendil-works/pi-protocol";
import type { V2PlanRegistry } from "@earendil-works/pi-server";
import { InMemoryV2PlanRegistry, validateV2Plan } from "@earendil-works/pi-server";

type Command =
	| { command: "load" }
	| { command: "update"; sessionId: string; value: string }
	| { command: "clear"; sessionId: string }
	| { command: "close" };
type Response = { id: number; result?: unknown; error?: string };
type Row = { sessionId: string; value: string };

function isResponse(value: unknown): value is Response {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "number";
}

/** SQLite-backed plan snapshot registry used by configured coding-agent daemons. */
export class SqliteV2PlanRegistry implements V2PlanRegistry {
	readonly #path: string;
	readonly #memory = new InMemoryV2PlanRegistry();
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#worker: Worker | undefined;
	#nextId = 1;
	#write = Promise.resolve();
	#load: Promise<void> | undefined;
	#loaded = false;
	#closed = false;

	constructor(path: string) {
		this.#path = path;
	}

	async read(sessionId: string): Promise<PlanSnapshot | undefined> {
		await this.#write;
		await this.#ensureLoaded();
		return this.#memory.read(sessionId);
	}

	update(sessionId: string, input: { readonly items: readonly PlanItem[]; readonly version?: number }) {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			const plan = validateV2Plan(await this.#memory.read(sessionId), input);
			await this.#request({ command: "update", sessionId, value: JSON.stringify(plan) });
			await this.#memory.update(sessionId, input);
			return plan;
		});
	}

	clear(sessionId: string): Promise<void> {
		return this.#enqueue(async () => {
			await this.#ensureLoaded();
			await this.#request({ command: "clear", sessionId });
			await this.#memory.clear(sessionId);
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		await this.#write;
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
		const load = this.#load ?? this.#hydrate();
		this.#load = load;
		try {
			await load;
		} finally {
			if (this.#load === load) this.#load = undefined;
		}
	}

	async #hydrate(): Promise<void> {
		for (const row of await this.#request<readonly Row[]>({ command: "load" }))
			await this.#memory.update(row.sessionId, parseJson(row.value));
		this.#loaded = true;
	}

	#request<T>(command: Command, closing = false): Promise<T> {
		if (this.#closed && !closing) return Promise.reject(new Error("SQLite plan registry is closed"));
		const worker = this.#worker ?? this.#createWorker();
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			worker.postMessage({ id, command });
		});
	}

	#createWorker(): Worker {
		const worker =
			typeof process.versions.bun === "string"
				? new Worker("./src/server/sqlite-plan-registry-worker.ts", { workerData: { path: this.#path } })
				: new Worker(
						new URL(
							import.meta.url.endsWith(".ts")
								? "./sqlite-plan-registry-worker.ts"
								: "./sqlite-plan-registry-worker.js",
							import.meta.url,
						),
						{ workerData: { path: this.#path } },
					);
		worker.on("message", (value: unknown) => this.#handle(value));
		worker.once("error", (error) => this.#fail(error));
		worker.once("exit", (code) => {
			if (!this.#closed && code !== 0) this.#fail(new Error(`SQLite plan worker exited with code ${code}`));
			if (this.#worker === worker) this.#worker = undefined;
		});
		this.#worker = worker;
		return worker;
	}

	#handle(value: unknown): void {
		if (!isResponse(value)) {
			this.#fail(new Error("Invalid SQLite plan worker response"));
			return;
		}
		const pending = this.#pending.get(value.id);
		if (pending === undefined) return;
		this.#pending.delete(value.id);
		if (value.error !== undefined) pending.reject(new Error(value.error));
		else pending.resolve(value.result);
	}

	#fail(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const write = this.#write.then(operation);
		this.#write = write.then(
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
