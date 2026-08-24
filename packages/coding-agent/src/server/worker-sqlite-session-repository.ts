import { Worker } from "node:worker_threads";
import type {
	BranchBounds,
	Entry,
	EntryPlacement,
	EntryQuery,
	ForkOptions,
	LaneRecord,
	LogItem,
	LogOptions,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	RecordQuery,
	RegisterWrite,
	SessionErrorCode,
	SessionRegister,
	SessionStats,
	SessionStorage,
	SessionTransactionStorage,
} from "@earendil-works/pi-agent-core";
import { Session, SessionError } from "@earendil-works/pi-agent-core";
import type {
	SqliteBackupReport,
	SqliteInspection,
	SqliteSessionCreateOptions,
	SqliteSessionListOptions,
	SqliteSessionMetadata,
	SqliteSessionRepository,
	SqliteWriterLeaseOptions,
} from "@earendil-works/pi-session-backend-sqlite-node";

type RepositoryCommand =
	| "create"
	| "open"
	| "list"
	| "inspect"
	| "verifyReopen"
	| "repairBranchCache"
	| "repairDerivedIndexes"
	| "backup"
	| "delete"
	| "fork"
	| "close";
type StorageCommand =
	| "getMetadata"
	| "getLanes"
	| "createLane"
	| "moveLane"
	| "appendEntry"
	| "appendRecord"
	| "appendRecords"
	| "appendTransaction"
	| "getRegister"
	| "appendAtomicTransaction"
	| "getEntry"
	| "findEntries"
	| "findEntriesOnBranch"
	| "findRecords"
	| "findOpenOperations"
	| "getLog"
	| "getName"
	| "setName"
	| "getLabel"
	| "setLabel"
	| "getStats";
type WorkerCommand =
	| { readonly scope: "repository"; readonly command: RepositoryCommand; readonly args: readonly unknown[] }
	| {
			readonly scope: "storage";
			readonly sessionId: string;
			readonly command: StorageCommand;
			readonly args: readonly unknown[];
	  };
type WorkerResponse = {
	readonly id: number;
	readonly result?: unknown;
	readonly error?: { readonly message: string; readonly name: string; readonly code?: SessionErrorCode };
};

export type SqliteSessionRepositoryLike = Pick<
	SqliteSessionRepository,
	| "create"
	| "open"
	| "list"
	| "inspect"
	| "verifyReopen"
	| "repairBranchCache"
	| "repairDerivedIndexes"
	| "backup"
	| "delete"
	| "fork"
	| "close"
>;

function isWorkerResponse(value: unknown): value is WorkerResponse {
	return value !== null && typeof value === "object" && "id" in value && typeof value.id === "number";
}

class WorkerSqliteSessionStorage
	implements SessionStorage<SqliteSessionMetadata>, SessionTransactionStorage<SqliteSessionMetadata>
{
	readonly #repository: WorkerSqliteSessionRepository;
	readonly #sessionId: string;

	constructor(repository: WorkerSqliteSessionRepository, sessionId: string) {
		this.#repository = repository;
		this.#sessionId = sessionId;
	}

	getMetadata(): Promise<SqliteSessionMetadata> {
		return this.#call("getMetadata");
	}
	getLanes(): Promise<{ lane: string; leafId: string | null }[]> {
		return this.#call("getLanes");
	}
	createLane(lane: string, at: string | null): Promise<void> {
		return this.#call("createLane", lane, at);
	}
	moveLane(lane: string, to: string | null): Promise<void> {
		return this.#call("moveLane", lane, to);
	}
	appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.#call("appendEntry", entry, lane);
	}
	appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		return this.#call("appendRecord", record);
	}
	appendRecords<TRecord extends LaneRecord>(records: readonly NewRecord<TRecord>[]): Promise<TRecord[]> {
		return this.#call("appendRecords", records);
	}
	appendTransaction<TRecord extends LaneRecord>(
		records: readonly NewRecord<TRecord>[],
		writes: readonly RegisterWrite[],
	): Promise<{ records: TRecord[]; registers: SessionRegister[] }> {
		return this.#call("appendTransaction", records, writes);
	}
	getRegister(namespace: string, key: string): Promise<SessionRegister | undefined> {
		return this.#call("getRegister", namespace, key);
	}
	appendAtomicTransaction(
		entries: readonly EntryPlacement[],
		records: readonly NewRecord[],
		writes: readonly RegisterWrite[],
	): Promise<{ entries: Entry[]; records: LaneRecord[]; registers: SessionRegister[] }> {
		return this.#call("appendAtomicTransaction", entries, records, writes);
	}
	getEntry(id: string): Promise<Entry | undefined> {
		return this.#call("getEntry", id);
	}
	findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return this.#call("findEntries", query);
	}
	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return this.#call("findEntriesOnBranch", query);
	}
	findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return this.#call("findRecords", query);
	}
	findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return this.#call("findOpenOperations", lane, options);
	}
	getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return this.#call("getLog", options);
	}
	getName(): Promise<string | undefined> {
		return this.#call("getName");
	}
	setName(name: string | undefined): Promise<void> {
		return this.#call("setName", name);
	}
	getLabel(id: string): Promise<string | undefined> {
		return this.#call("getLabel", id);
	}
	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.#call("setLabel", id, label);
	}
	getStats(): Promise<SessionStats> {
		return this.#call("getStats");
	}

	#call<T>(command: StorageCommand, ...args: readonly unknown[]): Promise<T> {
		return this.#repository.storage<T>(this.#sessionId, command, args);
	}
}

/** Worker-owned SQLite repository for configured daemon sessions. */
export class WorkerSqliteSessionRepository implements SqliteSessionRepositoryLike {
	readonly #databasePath: string;
	readonly #cwd: string;
	readonly #writerLease: SqliteWriterLeaseOptions | undefined;
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	#worker: Worker | undefined;
	#nextRequestId = 1;
	#closed = false;

	constructor(options: { databasePath: string; cwd: string; writerLease?: SqliteWriterLeaseOptions }) {
		this.#databasePath = options.databasePath;
		this.#cwd = options.cwd;
		this.#writerLease = options.writerLease;
	}

	async create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>> {
		return this.#session(await this.#repository("create", options));
	}
	async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
		return this.#session(await this.#repository("open", metadata));
	}
	list(options: SqliteSessionListOptions = {}): Promise<SqliteSessionMetadata[]> {
		return this.#repository("list", options);
	}
	inspect(): Promise<SqliteInspection> {
		return this.#repository("inspect");
	}
	verifyReopen(): Promise<SqliteInspection> {
		return this.#repository("verifyReopen");
	}
	repairBranchCache(metadata: SqliteSessionMetadata): Promise<void> {
		return this.#repository("repairBranchCache", metadata);
	}
	repairDerivedIndexes(): Promise<readonly string[]> {
		return this.#repository("repairDerivedIndexes");
	}
	backup(destinationPath: string): Promise<SqliteBackupReport> {
		return this.#repository("backup", destinationPath);
	}
	delete(metadata: SqliteSessionMetadata): Promise<void> {
		return this.#repository("delete", metadata);
	}
	async fork(
		source: SqliteSessionMetadata,
		options: ForkOptions & SqliteSessionCreateOptions,
	): Promise<Session<SqliteSessionMetadata>> {
		return this.#session(await this.#repository("fork", source, options));
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const worker = this.#worker;
		if (worker !== undefined) {
			try {
				await this.#repository("close");
			} finally {
				await worker.terminate();
				this.#worker = undefined;
			}
		}
	}

	storage<T>(sessionId: string, command: StorageCommand, args: readonly unknown[]): Promise<T> {
		return this.#request({ scope: "storage", sessionId, command, args });
	}

	async #session(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
		return new Session(new WorkerSqliteSessionStorage(this, metadata.id));
	}

	#repository<T>(command: RepositoryCommand, ...args: readonly unknown[]): Promise<T> {
		return this.#request({ scope: "repository", command, args });
	}

	#request<T>(command: WorkerCommand): Promise<T> {
		if (this.#closed && command.command !== "close")
			return Promise.reject(new Error("SQLite session repository is closed"));
		const worker = this.#worker ?? this.#createWorker();
		const id = this.#nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			worker.postMessage({ id, command });
		});
	}

	#createWorker(): Worker {
		const workerData = { databasePath: this.#databasePath, cwd: this.#cwd, writerLease: this.#writerLease };
		const sourceWorker = import.meta.url.endsWith(".ts");
		const nodeOptions = {
			workerData,
			...(sourceWorker ? { execArgv: [...process.execArgv, "--import", "tsx"] } : {}),
		};
		const worker =
			typeof process.versions.bun === "string"
				? new Worker("./src/server/worker-sqlite-session-repository-worker.ts", {
						workerData,
					})
				: new Worker(
						new URL(
							import.meta.url.endsWith(".ts")
								? "./worker-sqlite-session-repository-worker.ts"
								: "./worker-sqlite-session-repository-worker.js",
							import.meta.url,
						),
						nodeOptions,
					);
		worker.on("message", (message: unknown) => this.#handleResponse(message));
		worker.once("error", (error) => this.#failPending(error));
		worker.once("exit", (code) => {
			if (!this.#closed && code !== 0)
				this.#failPending(new Error(`SQLite session worker exited with code ${code}`));
			if (this.#worker === worker) this.#worker = undefined;
		});
		this.#worker = worker;
		return worker;
	}

	#handleResponse(message: unknown): void {
		if (!isWorkerResponse(message)) {
			this.#failPending(new Error("Invalid SQLite session worker response"));
			return;
		}
		const request = this.#pending.get(message.id);
		if (request === undefined) return;
		this.#pending.delete(message.id);
		if (message.error !== undefined) {
			request.reject(
				message.error.code === undefined
					? Object.assign(new Error(message.error.message), { name: message.error.name })
					: new SessionError(message.error.code, message.error.message),
			);
		} else request.resolve(message.result);
	}

	#failPending(error: Error): void {
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
	}
}
