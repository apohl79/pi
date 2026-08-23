import { createHash } from "node:crypto";
import { type SessionMutation, SessionState } from "../state.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	SessionError,
	type SessionStats,
	type SessionStorage,
} from "../types.ts";
import { encodeHeader, encodeMutation, metadataFromHeader, parseHeader, parseMutation } from "./codec.ts";
import { fileResult, invalidFile, JsonlDecodeError } from "./errors.ts";
import type { JsonlSessionMetadata, JsonlSessionRepoFileSystem, JsonlV4Header } from "./types.ts";

const ROOT_FINGERPRINT_LINES = 8;

function rootFingerprint(lines: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(lines.slice(0, ROOT_FINGERPRINT_LINES))).digest("hex");
}

/**
 * Build a complete sibling temporary file, then atomically rename it over the destination.
 * The populate callback must create or overwrite `tempPath` with the complete file. The
 * destination is untouched until the rename commits, so a process crash while populating
 * can leave only the ignored `.tmp` file behind.
 *
 * Rejects when population or rename fails. On rejection, temporary-file removal is
 * best-effort and the original error is preserved. Callers must serialize publications to
 * the same destination because they share its deterministic `.tmp` path.
 */
async function publishFileAtomically(
	fs: JsonlSessionRepoFileSystem,
	destinationPath: string,
	populate: (tempPath: string) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		await populate(tempPath);
		fileResult(await fs.renameFile(tempPath, destinationPath), `Failed to publish staged file ${destinationPath}`);
	} catch (error) {
		await fs.remove(tempPath, { force: true });
		throw error;
	}
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	/** Serialize mutations across independently loaded storage instances in this process. */
	private static readonly mutationTails = new Map<string, Promise<void>>();
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private state = new SessionState();
	private tail: Promise<void> = Promise.resolve();
	/** Number of complete physical lines already projected into `state` (header included). */
	private persistedLineCount = 0;
	private persistedSize = 0;
	private persistedModifiedAt = 0;
	private persistedIdentity: string | undefined;
	/** A bounded prefix fingerprint catches replacement even when file metadata is unchanged. */
	private persistedRootLines: string[] = [];

	constructor(fs: JsonlSessionRepoFileSystem, metadata: JsonlSessionMetadata) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
	}

	static async create(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		header: JsonlV4Header,
	): Promise<JsonlSessionStorage> {
		fileResult(await fs.writeFile(path, encodeHeader(header)), `Failed to initialize session ${path}`);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
		storage.persistedLineCount = 1;
		storage.persistedSize = new TextEncoder().encode(encodeHeader(header)).byteLength;
		storage.persistedModifiedAt = fileInfo.mtimeMs;
		storage.persistedIdentity = fileInfo.identity;
		storage.persistedRootLines = [encodeHeader(header).trimEnd()];
		return storage;
	}

	static async load(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		// Recovery may replace/truncate the file. Serialize the entire load, including
		// torn-tail repair, with appends from every storage instance in this process.
		return JsonlSessionStorage.withMutationLock(path, () => JsonlSessionStorage.loadUnlocked(fs, path));
	}

	private static async loadUnlocked(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) {
			throw invalidFile(path, 1, new JsonlDecodeError("schema", "is missing a header"));
		}
		const headerResult = parseHeader(physicalLines[0]);
		if (!headerResult.ok) throw invalidFile(path, 1, headerResult.error);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(fs, metadataFromHeader(headerResult.value, path, fileInfo.mtimeMs));
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			const mutationResult = parseMutation(line);
			if (!mutationResult.ok) {
				const isTornTail = index === physicalLines.length - 1 && mutationResult.error.kind === "syntax";
				if (isTornTail) {
					// Drop the unacknowledged partial append by atomically publishing the valid prefix.
					const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
					await publishFileAtomically(fs, path, async (tempPath) => {
						fileResult(await fs.writeFile(tempPath, validPrefix), `Failed to stage torn-tail repair ${path}`);
					});
					storage.persistedLineCount = index;
					storage.persistedSize = new TextEncoder().encode(validPrefix).byteLength;
					const repairedInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
					storage.persistedModifiedAt = repairedInfo.mtimeMs;
					storage.persistedIdentity = repairedInfo.identity;
					storage.persistedRootLines = physicalLines.slice(0, ROOT_FINGERPRINT_LINES);
					return storage;
				}
				throw invalidFile(path, index + 1, mutationResult.error);
			}
			try {
				storage.applyMutation(mutationResult.value);
			} catch (error) {
				if (error instanceof SessionError && error.code === "invalid_entry") {
					throw invalidFile(path, index + 1, error);
				}
				throw error;
			}
		}
		if (!content.endsWith("\n")) {
			fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
		}
		storage.persistedLineCount = physicalLines.length;
		storage.persistedSize = fileInfo.size + (content.endsWith("\n") ? 0 : 1);
		storage.persistedModifiedAt = fileInfo.mtimeMs;
		storage.persistedIdentity = fileInfo.identity;
		storage.persistedRootLines = physicalLines.slice(0, ROOT_FINGERPRINT_LINES);
		return storage;
	}

	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<JsonlSessionStorage> {
		const mutations = this.state.createForkMutations(options);
		await publishFileAtomically(this.fs, path, async (tempPath) => {
			const targetStorage = await JsonlSessionStorage.create(this.fs, tempPath, header);
			for (const mutation of mutations) {
				await targetStorage.appendMutation(mutation);
				targetStorage.applyMutation(mutation);
			}
		});
		return JsonlSessionStorage.load(this.fs, path);
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: SessionMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
			const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
			if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
				throw new SessionError(
					"storage",
					`Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
				);
			}
			const record = {
				...structuredClone(newRecord),
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TRecord;
			const mutation: SessionMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(id);
			const mutation: SessionMutation = {
				kind: "fact",
				seq: this.state.nextSequence,
				fact: "label",
				targetId: id,
				label,
			};
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(async () => {
			const key = this.metadata.path;
			const predecessor = JsonlSessionStorage.mutationTails.get(key) ?? Promise.resolve();
			let release!: () => void;
			const lock = new Promise<void>((resolve) => {
				release = resolve;
			});
			const chain = predecessor.then(() => lock);
			JsonlSessionStorage.mutationTails.set(key, chain);
			await predecessor;
			try {
				// Another instance may have appended since this instance was loaded. Refresh only
				// when file metadata changed; the common single-writer path no longer reparses the
				// complete history for every append. External suffixes are projected incrementally.
				await this.refreshFromDisk(key);
				return await operation();
			} finally {
				release();
				if (JsonlSessionStorage.mutationTails.get(key) === chain) JsonlSessionStorage.mutationTails.delete(key);
			}
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private static async withMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const predecessor = JsonlSessionStorage.mutationTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chain = predecessor.then(() => lock);
		JsonlSessionStorage.mutationTails.set(key, chain);
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
			if (JsonlSessionStorage.mutationTails.get(key) === chain) JsonlSessionStorage.mutationTails.delete(key);
		}
	}

	private async appendMutation(mutation: SessionMutation): Promise<void> {
		const encoded = encodeMutation(mutation);
		try {
			fileResult(
				await this.fs.appendFile(this.metadata.path, encoded),
				`Failed to append session ${this.metadata.path}`,
			);
			this.persistedLineCount += 1;
			this.persistedSize += new TextEncoder().encode(encoded).byteLength;
			if (this.persistedRootLines.length < ROOT_FINGERPRINT_LINES) {
				this.persistedRootLines.push(encoded.trimEnd());
			}
			// Metadata refresh is only an optimization for detecting external writers;
			// never turn a successful append into an error if that optional read fails.
			try {
				const fileInfo = await this.fs.fileInfo(this.metadata.path);
				if (fileInfo.ok) {
					this.persistedModifiedAt = fileInfo.value.mtimeMs;
					this.persistedIdentity = fileInfo.value.identity;
				}
			} catch {
				// The append already committed; retain the locally projected metadata.
			}
		} catch (error) {
			// An append may be durable even when the backend reports a transport
			// error. Refresh local state so callers can detect the committed record
			// and safely retry idempotent operations.
			try {
				const fresh = await JsonlSessionStorage.loadUnlocked(this.fs, this.metadata.path);
				this.state = fresh.state;
				// The append can be durable even when the backend reports a transport
				// error. Keep the incremental refresh cursor in sync with the canonical
				// reload, otherwise the next mutation replays the committed suffix.
				this.persistedLineCount = fresh.persistedLineCount;
				this.persistedSize = fresh.persistedSize;
				this.persistedModifiedAt = fresh.persistedModifiedAt;
				this.persistedIdentity = fresh.persistedIdentity;
				this.persistedRootLines = fresh.persistedRootLines;
			} catch {
				// Preserve the original append error when the recovery read fails.
			}
			throw error;
		}
	}

	private async refreshFromDisk(path: string): Promise<void> {
		const fileInfo = fileResult(await this.fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const rootLines = fileResult(
			await this.fs.readTextLines(path, { maxLines: ROOT_FINGERPRINT_LINES }),
			`Failed to read session root ${path}`,
		);
		const rootUnchanged = rootFingerprint(rootLines) === rootFingerprint(this.persistedRootLines);
		if (
			rootUnchanged &&
			fileInfo.size === this.persistedSize &&
			fileInfo.mtimeMs === this.persistedModifiedAt &&
			(fileInfo.identity === undefined || this.persistedIdentity === undefined || fileInfo.identity === this.persistedIdentity)
		) return;
		const content = fileResult(await this.fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		// A replacement/truncation (fork publication or recovery) cannot be safely
		// applied as a suffix; use the canonical loader in that uncommon case.
		if (physicalLines.length < this.persistedLineCount || !rootUnchanged) {
			const fresh = await JsonlSessionStorage.loadUnlocked(this.fs, path);
			this.state = fresh.state;
			this.persistedLineCount = fresh.persistedLineCount;
			this.persistedSize = fresh.persistedSize;
			this.persistedModifiedAt = fresh.persistedModifiedAt;
			this.persistedIdentity = fresh.persistedIdentity;
			this.persistedRootLines = fresh.persistedRootLines;
			return;
		}
		const suffix: SessionMutation[] = [];
		for (let index = this.persistedLineCount; index < physicalLines.length; index++) {
			const mutationResult = parseMutation(physicalLines[index]!);
			if (!mutationResult.ok) {
				const fresh = await JsonlSessionStorage.loadUnlocked(this.fs, path);
				this.state = fresh.state;
				this.persistedLineCount = fresh.persistedLineCount;
				this.persistedSize = fresh.persistedSize;
				this.persistedModifiedAt = fresh.persistedModifiedAt;
				this.persistedIdentity = fresh.persistedIdentity;
				this.persistedRootLines = fresh.persistedRootLines;
				return;
			}
			suffix.push(mutationResult.value);
		}
		// Apply the external suffix to a staged projection. SessionState mutates
		// its collections in place, so retaining the original reference would not
		// roll back mutations that precede a later validation failure.
		const stagedState = this.state.clone();
		for (const mutation of suffix) stagedState.applyMutation(mutation);
		this.state = stagedState;
		this.persistedLineCount = physicalLines.length;
		this.persistedSize = fileInfo.size;
		this.persistedModifiedAt = fileInfo.mtimeMs;
		this.persistedIdentity = fileInfo.identity;
		this.persistedRootLines = physicalLines.slice(0, ROOT_FINGERPRINT_LINES);
	}

	private applyMutation(mutation: SessionMutation): void {
		this.state.applyMutation(mutation);
	}
}
