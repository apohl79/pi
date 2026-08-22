import {
	type BranchBounds,
	type Entry,
	type EntryOrder,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	MAX_DURABLE_COMPACTION_TAIL_BYTES,
	MAX_DURABLE_COMPACTION_TAIL_MESSAGES,
	MAX_DURABLE_COMPACTION_TEXT_LENGTH,
	MAX_DURABLE_EXTENSION_PAYLOAD_BYTES,
	MAX_DURABLE_EXTENSION_PAYLOAD_DEPTH,
	type OperationStartedRecord,
	type RecordQuery,
	SessionError,
	type SessionStats,
} from "./types.ts";

export type SessionMutation =
	| { kind: "entry"; lane?: string; entry: Entry }
	| { kind: "record"; record: LaneRecord }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name: string | undefined }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label: string | undefined };

type InvalidMutation = (message: string) => never;

function invalidMutation(message: string): never {
	throw new SessionError("invalid_entry", `Invalid session mutation: ${message}`);
}

function assertBoundedJson(
	value: unknown,
	label: string,
	maxBytes = MAX_DURABLE_EXTENSION_PAYLOAD_BYTES,
	invalid: InvalidMutation = invalidMutation,
): void {
	const active = new WeakSet<object>();
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let bytes = 0;
	while (stack.length > 0) {
		const { value: candidate, depth } = stack.pop()!;
		if (candidate === null || typeof candidate === "boolean") {
			bytes += 5;
		} else if (typeof candidate === "string") {
			bytes += new TextEncoder().encode(candidate).byteLength;
		} else if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) invalid(`${label} contains a non-finite number`);
			bytes += 16;
		} else if (typeof candidate === "object") {
			if (depth >= MAX_DURABLE_EXTENSION_PAYLOAD_DEPTH) invalid(`${label} exceeds maximum nesting depth`);
			if (active.has(candidate)) invalid(`${label} contains a cycle`);
			active.add(candidate);
			if (Array.isArray(candidate)) {
				bytes += 2;
				for (let index = candidate.length - 1; index >= 0; index--)
					stack.push({ value: candidate[index], depth: depth + 1 });
			} else {
				for (const [key, item] of Object.entries(candidate)) {
					bytes += new TextEncoder().encode(key).byteLength + 4;
					stack.push({ value: item, depth: depth + 1 });
				}
			}
			active.delete(candidate);
		} else {
			invalid(`${label} contains unsupported data`);
		}
		if (bytes > maxBytes) invalid(`${label} exceeds ${maxBytes} bytes`);
	}
}

export function assertBoundedEntryPayload(entry: Entry, invalid: InvalidMutation = invalidMutation): void {
	if (entry.type === "compaction") {
		if (typeof entry.summary !== "string" || entry.summary.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			invalid("compaction summary is invalid or too large");
		if (!Array.isArray(entry.retainedTail)) invalid("compaction retainedTail is not an array");
		if (entry.retainedTail.length > MAX_DURABLE_COMPACTION_TAIL_MESSAGES) {
			invalid(`compaction retainedTail exceeds ${MAX_DURABLE_COMPACTION_TAIL_MESSAGES} messages`);
		}
		assertBoundedJson(entry.retainedTail, "compaction retainedTail", MAX_DURABLE_COMPACTION_TAIL_BYTES, invalid);
		if (entry.details !== undefined) assertBoundedJson(entry.details, "compaction details", undefined, invalid);
		if (entry.usage !== undefined) assertBoundedJson(entry.usage, "compaction usage", undefined, invalid);
	} else if (entry.type === "branch_summary") {
		if (typeof entry.summary !== "string" || entry.summary.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH)
			invalid("branch summary is invalid or too large");
		if (entry.details !== undefined) assertBoundedJson(entry.details, "branch summary details", undefined, invalid);
		if (entry.usage !== undefined) assertBoundedJson(entry.usage, "branch summary usage", undefined, invalid);
	} else if (entry.type === "custom" && entry.data !== undefined) {
		assertBoundedJson(entry.data, "custom entry data", undefined, invalid);
	}
}

function assertValidLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

function assertValidCursor(afterSeq: number | undefined): void {
	if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
		throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
	}
}

function* ordered<T>(items: readonly T[], order: EntryOrder | undefined): IterableIterator<T> {
	if (order === "oldestFirst") {
		yield* items;
		return;
	}
	for (let index = items.length - 1; index >= 0; index--) yield items[index]!;
}

export class SessionState {
	private sequence = 0;
	private readonly usedIds = new Set<string>();
	private readonly entries: Entry[] = [];
	private readonly entriesById = new Map<string, Entry>();
	private readonly records: LaneRecord[] = [];
	private readonly openOperationsByLane = new Map<string, Map<string, OperationStartedRecord>>();
	private readonly lanes = new Map<string, string | null>([["main", null]]);
	private readonly log: LogItem[] = [];
	private readonly stats: SessionStats = {
		messageCount: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	};
	private name: string | undefined;
	private readonly labels = new Map<string, string>();

	get nextSequence(): number {
		return this.sequence + 1;
	}

	getLanes(): LanePointer[] {
		return [...this.lanes].map(([lane, leafId]) => ({ lane, leafId }));
	}

	requireLane(lane: string): string | null {
		const leafId = this.lanes.get(lane);
		if (leafId === undefined) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return leafId;
	}

	validateNewLane(lane: string): void {
		if (this.lanes.has(lane)) throw new SessionError("already_exists", `Lane already exists: ${lane}`);
	}

	validateTarget(targetId: string | null): void {
		if (targetId !== null && !this.entriesById.has(targetId)) {
			throw new SessionError("not_found", `Entry not found: ${targetId}`);
		}
	}

	validateUnusedId(id: string): void {
		if (this.usedIds.has(id)) throw new SessionError("already_exists", `Session id already exists: ${id}`);
	}

	applyMutation(mutation: SessionMutation, invalid: InvalidMutation = invalidMutation): void {
		const seq =
			mutation.kind === "entry"
				? mutation.entry.seq
				: mutation.kind === "record"
					? mutation.record.seq
					: mutation.seq;
		if (seq !== this.sequence + 1) invalid(`has non-consecutive seq ${seq}`);

		switch (mutation.kind) {
			case "entry": {
				assertBoundedEntryPayload(mutation.entry);
				if (this.usedIds.has(mutation.entry.id)) invalid(`contains duplicate id ${mutation.entry.id}`);
				if (mutation.lane !== undefined) {
					const leafId = this.lanes.get(mutation.lane);
					if (leafId === undefined) invalid(`references missing lane ${mutation.lane}`);
					if (mutation.entry.parentId !== leafId) invalid("does not chain to the lane leaf");
				}
				if (mutation.entry.parentId !== null && !this.entriesById.has(mutation.entry.parentId)) {
					invalid(`references missing parent ${mutation.entry.parentId}`);
				}
				this.sequence = seq;
				this.usedIds.add(mutation.entry.id);
				this.entries.push(mutation.entry);
				this.entriesById.set(mutation.entry.id, mutation.entry);
				if (mutation.lane !== undefined) this.lanes.set(mutation.lane, mutation.entry.id);
				this.log.push({ kind: "entry", seq, entry: mutation.entry });
				if (mutation.entry.type === "message") this.stats.messageCount += 1;
				break;
			}
			case "record": {
				if (!this.lanes.has(mutation.record.lane)) invalid(`references missing lane ${mutation.record.lane}`);
				if (this.usedIds.has(mutation.record.id)) invalid(`contains duplicate id ${mutation.record.id}`);
				if (mutation.record.type === "operation_started" && "customInstructions" in mutation.record.intent) {
					const customInstructions = mutation.record.intent.customInstructions;
					if (
						typeof customInstructions !== "string" ||
						customInstructions.length > MAX_DURABLE_COMPACTION_TEXT_LENGTH
					) {
						invalid(`has customInstructions exceeding ${MAX_DURABLE_COMPACTION_TEXT_LENGTH} characters`);
					}
				}
				this.sequence = seq;
				this.usedIds.add(mutation.record.id);
				this.records.push(mutation.record);
				if (mutation.record.type === "operation_started") {
					let openOperations = this.openOperationsByLane.get(mutation.record.lane);
					if (!openOperations) {
						openOperations = new Map();
						this.openOperationsByLane.set(mutation.record.lane, openOperations);
					}
					openOperations.set(mutation.record.id, mutation.record);
				} else if (mutation.record.type === "operation_finished") {
					this.openOperationsByLane.get(mutation.record.lane)?.delete(mutation.record.runId);
				}
				this.log.push({ kind: "record", seq, record: mutation.record });
				if (mutation.record.type === "usage") {
					this.stats.cachedTokens += mutation.record.usage.cacheRead;
					this.stats.uncachedTokens += mutation.record.usage.input + mutation.record.usage.cacheWrite;
					this.stats.totalTokens += mutation.record.usage.totalTokens;
					this.stats.costTotal += mutation.record.usage.cost.total;
				}
				break;
			}
			case "lane":
				if (mutation.leafId !== null && !this.entriesById.has(mutation.leafId)) {
					invalid(`references missing lane target ${mutation.leafId}`);
				}
				this.sequence = seq;
				this.lanes.set(mutation.lane, mutation.leafId);
				this.log.push({ kind: "lane", seq, lane: mutation.lane, leafId: mutation.leafId });
				break;
			case "fact":
				if (mutation.fact === "label" && !this.entriesById.has(mutation.targetId)) {
					invalid(`references missing label target ${mutation.targetId}`);
				}
				this.sequence = seq;
				if (mutation.fact === "name") {
					this.name = mutation.name;
					this.log.push({ kind: "fact", seq, fact: "name", name: mutation.name });
				} else {
					if (mutation.label === undefined) this.labels.delete(mutation.targetId);
					else this.labels.set(mutation.targetId, mutation.label);
					this.log.push({
						kind: "fact",
						seq,
						fact: "label",
						targetId: mutation.targetId,
						label: mutation.label,
					});
				}
				break;
		}
	}

	getEntry(id: string): Entry | undefined {
		return this.entriesById.get(id);
	}

	findEntries(query: EntryQuery = {}): Entry[] {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const results: Entry[] = [];
		for (const entry of ordered(this.entries, query.order)) {
			if (!this.matchesEntryQuery(entry, query)) continue;
			results.push(entry);
			if (results.length === query.limit) break;
		}
		return results;
	}

	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Entry[] {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const results: Entry[] = [];
		if (query.order === "oldestFirst") {
			for (const entry of [...this.walkToRoot(query.start)].reverse()) {
				const reachedBound = entry.id === query.stopAtId || entry.type === query.stopAtType;
				if (this.matchesEntryQuery(entry, query)) results.push(entry);
				if (reachedBound || results.length === query.limit) break;
			}
		} else {
			for (const entry of this.walkToRoot(query.start, query)) {
				if (this.matchesEntryQuery(entry, query)) results.push(entry);
				if (results.length === query.limit) break;
			}
		}
		return results;
	}

	findRecords(query: RecordQuery = {}): LaneRecord[] {
		assertValidLimit(query.limit);
		assertValidCursor(query.afterSeq);
		const results: LaneRecord[] = [];
		for (const record of ordered(this.records, query.order)) {
			if (!this.matchesRecordQuery(record, query)) continue;
			results.push(record);
			if (results.length === query.limit) break;
		}
		return results;
	}

	findOpenOperations(lane: string, options?: { limit?: number }): OperationStartedRecord[] {
		assertValidLimit(options?.limit);
		const openOperationsById = this.openOperationsByLane.get(lane);
		const openOperations = openOperationsById ? [...openOperationsById.values()].reverse() : [];
		return options?.limit === undefined ? openOperations : openOperations.slice(0, options.limit);
	}

	getLog(options: LogOptions = {}): LogItem[] {
		assertValidLimit(options.limit);
		assertValidCursor(options.afterSeq);
		const results: LogItem[] = [];
		for (const item of this.log) {
			if (options.afterSeq !== undefined && item.seq <= options.afterSeq) continue;
			results.push(item);
			if (results.length === options.limit) break;
		}
		return results;
	}

	getName(): string | undefined {
		return this.name;
	}

	getLabel(id: string): string | undefined {
		return this.labels.get(id);
	}

	getStats(): SessionStats {
		return this.stats;
	}

	/**
	 * Copy the projection before applying an externally sourced suffix. The
	 * collections are intentionally copied so a failed speculative mutation
	 * cannot leak into the live session state.
	 */
	clone(): SessionState {
		const copy = new SessionState();
		copy.sequence = this.sequence;
		for (const id of this.usedIds) copy.usedIds.add(id);

		for (const source of this.entries) {
			const entry = structuredClone(source);
			copy.entries.push(entry);
			copy.entriesById.set(entry.id, entry);
		}
		for (const source of this.records) copy.records.push(structuredClone(source));
		const recordsById = new Map(copy.records.map((record) => [record.id, record]));
		for (const [lane, operations] of this.openOperationsByLane) {
			const copiedOperations = new Map<string, OperationStartedRecord>();
			for (const [id] of operations) {
				const record = recordsById.get(id);
				if (record?.type === "operation_started") copiedOperations.set(id, record);
			}
			copy.openOperationsByLane.set(lane, copiedOperations);
		}
		for (const [lane, leafId] of this.lanes) copy.lanes.set(lane, leafId);
		copy.log.push(...structuredClone(this.log));
		copy.stats.messageCount = this.stats.messageCount;
		copy.stats.cachedTokens = this.stats.cachedTokens;
		copy.stats.uncachedTokens = this.stats.uncachedTokens;
		copy.stats.totalTokens = this.stats.totalTokens;
		copy.stats.costTotal = this.stats.costTotal;
		copy.name = this.name;
		for (const [id, label] of this.labels) copy.labels.set(id, label);
		return copy;
	}

	createForkMutations(options: ForkOptions): SessionMutation[] {
		let copiedEntries: Entry[];
		let forkLanes: LanePointer[];
		if (options.scope === "tree") {
			copiedEntries = this.findEntries({ order: "oldestFirst" });
			forkLanes = this.getLanes();
		} else {
			const selectedEntryId = options.entryId ?? this.requireLane("main");
			let targetId: string | null = null;
			if (selectedEntryId !== null) {
				const entry = this.getEntry(selectedEntryId);
				if (!entry || entry.type !== "message") {
					throw new SessionError("invalid_fork_target", `Fork target is not a message entry: ${selectedEntryId}`);
				}
				const position = options.position ?? (options.entryId === undefined ? "at" : "before");
				targetId = position === "at" ? entry.id : entry.parentId;
			}
			copiedEntries = targetId === null ? [] : this.findEntriesOnBranch({ start: targetId, order: "oldestFirst" });
			forkLanes = [{ lane: "main", leafId: targetId }];
		}

		const mutations: SessionMutation[] = [];
		let sequence = 1;
		for (const sourceEntry of copiedEntries) {
			mutations.push({ kind: "entry", entry: { ...structuredClone(sourceEntry), seq: sequence++ } });
		}
		for (const pointer of forkLanes) {
			mutations.push({ kind: "lane", seq: sequence++, lane: pointer.lane, leafId: pointer.leafId });
		}
		if (this.name !== undefined) {
			mutations.push({ kind: "fact", seq: sequence++, fact: "name", name: this.name });
		}
		for (const entry of copiedEntries) {
			const label = this.labels.get(entry.id);
			if (label !== undefined) {
				mutations.push({ kind: "fact", seq: sequence++, fact: "label", targetId: entry.id, label });
			}
		}
		return mutations;
	}

	private *walkToRoot(
		start: string | null,
		bounds?: Pick<BranchBounds, "stopAtId" | "stopAtType">,
	): IterableIterator<Entry> {
		if (start === null) return;
		const visited = new Set<string>();
		let current = this.entriesById.get(start);
		if (!current) throw new SessionError("not_found", `Entry not found: ${start}`);
		while (current) {
			if (visited.has(current.id)) {
				throw new SessionError("invalid_entry", `Session branch contains a cycle at ${current.id}`);
			}
			visited.add(current.id);
			yield current;
			if (current.id === bounds?.stopAtId || current.type === bounds?.stopAtType || current.parentId === null) break;
			const parentId: string = current.parentId;
			current = this.entriesById.get(parentId);
			if (!current) throw new SessionError("invalid_entry", `Entry not found: ${parentId}`);
		}
	}

	private matchesEntryQuery(entry: Entry, query: EntryQuery): boolean {
		return (
			(query.type === undefined || entry.type === query.type) &&
			(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)) &&
			(query.cursor === undefined ||
				(query.order === "oldestFirst" ? entry.seq > query.cursor.afterSeq : entry.seq < query.cursor.afterSeq))
		);
	}

	private matchesRecordQuery(record: LaneRecord, query: RecordQuery): boolean {
		return (
			(query.lane === undefined || record.lane === query.lane) &&
			(query.type === undefined || record.type === query.type) &&
			(query.runId === undefined ||
				(record.type === "operation_started"
					? record.id === query.runId
					: "runId" in record && record.runId === query.runId)) &&
			(query.operationKind === undefined ||
				(record.type === "operation_started" && record.intent.kind === query.operationKind)) &&
			(query.afterSeq === undefined || record.seq > query.afterSeq)
		);
	}
}
