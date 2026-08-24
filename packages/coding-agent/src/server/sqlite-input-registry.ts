import { Worker } from "node:worker_threads";
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

type WorkerCommand =
	| { readonly command: "load" }
	| { readonly command: "save"; readonly requestId: string; readonly value: string }
	| { readonly command: "consume"; readonly requestId: string }
	| { readonly command: "close" };
type WorkerResponse = { readonly id: number; readonly result?: unknown; readonly error?: string };
type InputStore = { readonly requests: readonly string[]; readonly consumed: readonly string[] };

function isWorkerResponse(value: unknown): value is WorkerResponse {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "number";
}

/** SQLite-backed structured-input registry used by configured coding-agent daemons. */
export class SqliteV2InputRegistry implements V2InputRegistry {
	readonly #databasePath: string;
	readonly #memory = new InMemoryV2InputRegistry();
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#worker: Worker | undefined;
	#nextRequestId = 1;
	#pendingWrite: Promise<void> = Promise.resolve();
	#loadPromise: Promise<void> | undefined;
	#loaded = false;
	#closed = false;
	readonly #responded = new Map<string, string[]>();
	readonly #consumed = new Set<string>();
	readonly #requests = new Map<string, V2InputRequest>();
	readonly #listeners = new Set<V2InputChangeListener>();

	constructor(databasePath: string) {
		this.#databasePath = databasePath;
		this.#memory.onChange?.((request) => this.#notify(request));
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
		});
	}

	cancel(requestId: string): Promise<V2InputRequest> {
		return this.#mutate(async () => {
			const next = cancelV2InputRequest(await this.#memory.read(requestId));
			return { durable: next, commit: () => this.#memory.cancel(requestId) };
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
			await this.#request({ command: "consume", requestId });
			this.#consumed.add(requestId);
			return structuredClone(request.answers ?? {});
		});
	}

	async close(): Promise<void> {
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
		await this.#request({ command: "save", requestId: request.id, value: JSON.stringify(request) });
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
		const stored = await this.#request<InputStore>({ command: "load" });
		const requests = stored.requests.map(parseJson);
		for (const persisted of requests) {
			const request = expireIfDue(persisted);
			if (request.status === "expired") {
				await this.#save(request);
			}
			this.#memory.restore(request);
			this.#requests.set(request.id, request);
			if (request.status === "responded") {
				const ids = this.#responded.get(request.sessionId) ?? [];
				ids.push(request.id);
				this.#responded.set(request.sessionId, ids);
			}
		}
		for (const requestId of stored.consumed) {
			const request = requests.find((candidate) => candidate.id === requestId);
			if (request?.status === "responded") {
				this.#consumed.add(request.id);
			}
		}
		this.#loaded = true;
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

	#request<T>(command: WorkerCommand, closing = false): Promise<T> {
		if (this.#closed && !closing) return Promise.reject(new Error("SQLite input registry is closed"));
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
				? new Worker("./src/server/sqlite-input-registry-worker.ts", {
						workerData: { databasePath: this.#databasePath },
					})
				: new Worker(
						new URL(
							import.meta.url.endsWith(".ts")
								? "./sqlite-input-registry-worker.ts"
								: "./sqlite-input-registry-worker.js",
							import.meta.url,
						),
						{ workerData: { databasePath: this.#databasePath } },
					);
		worker.on("message", (message: unknown) => this.#handleResponse(message));
		worker.once("error", (error) => this.#failPending(error));
		worker.once("exit", (code) => {
			if (!this.#closed && code !== 0) this.#failPending(new Error(`SQLite input worker exited with code ${code}`));
			if (this.#worker === worker) this.#worker = undefined;
		});
		this.#worker = worker;
		return worker;
	}

	#handleResponse(message: unknown): void {
		if (!isWorkerResponse(message)) {
			this.#failPending(new Error("Invalid SQLite input worker response"));
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
