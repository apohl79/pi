import { chmod, lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "@earendil-works/pi-protocol";
import { MAX_V2_ARRAY_ITEMS, MAX_V2_JSON_DEPTH, MAX_V2_STRING_LENGTH } from "@earendil-works/pi-protocol";

const MAX_LEDGER_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IDENTITY_LENGTH = 256;

export type V2UsagePurpose = "agent" | "compaction" | "sessionName" | "otherSideband";
export type V2UsagePricing = "providerReported" | "catalog" | "subscription" | "unknown";

export type V2UsageLedgerEntry = Readonly<{
	responseId: string;
	sessionId: string;
	agentId: string;
	operationId: string;
	turnId?: string;
	goalId?: string;
	purpose: V2UsagePurpose;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	pricing: V2UsagePricing;
	priceSnapshot?: JsonValue;
	costUsd?: number;
	imageUnits?: number;
	createdAt: number;
}>;

export type V2UsageFilter = Readonly<{
	sessionId?: string;
	agentId?: string;
	turnId?: string;
	goalId?: string;
	provider?: string;
	model?: string;
	purpose?: V2UsagePurpose;
}>;

export type V2UsageAggregate = Readonly<{
	responses: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	imageUnits: number;
	costUsd?: number;
	pricingState: "known" | "unknown" | "subscription";
}>;

export interface V2UsageLedger {
	record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry>;
	read(filter?: V2UsageFilter): Promise<readonly V2UsageLedgerEntry[]>;
	aggregate(filter?: V2UsageFilter): Promise<V2UsageAggregate>;
}

function validateEntry(entry: V2UsageLedgerEntry): V2UsageLedgerEntry {
	for (const key of ["responseId", "sessionId", "agentId", "operationId", "provider", "model"] as const)
		if (typeof entry[key] !== "string" || entry[key].length === 0 || entry[key].length > MAX_IDENTITY_LENGTH)
			throw new Error(`Usage identity field is invalid: ${key}`);
	for (const key of ["turnId", "goalId"] as const)
		if (entry[key] !== undefined && (typeof entry[key] !== "string" || entry[key].length === 0 || entry[key].length > MAX_IDENTITY_LENGTH))
			throw new Error(`Usage identity field is invalid: ${key}`);
	for (const [key, value] of Object.entries(entry))
		if (typeof value === "string" && (value.length === 0 || value.length > MAX_IDENTITY_LENGTH))
			throw new Error(`Usage identity field is invalid: ${key}`);
	if (!entry.responseId || !entry.sessionId || !entry.agentId || !entry.operationId)
		throw new Error("Usage ledger identity fields are required");
	if (!["agent", "compaction", "sessionName", "otherSideband"].includes(entry.purpose)) throw new Error("Usage purpose is invalid");
	if (!["providerReported", "catalog", "subscription", "unknown"].includes(entry.pricing)) throw new Error("Usage pricing is invalid");
	if (entry.priceSnapshot !== undefined) assertBoundedJson(entry.priceSnapshot);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "createdAt"] as const) {
		const value = entry[key];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
			throw new Error(`Usage field is invalid: ${key}`);
	}
	for (const key of ["reasoning", "costUsd", "imageUnits"] as const) {
		const value = entry[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER))
			throw new Error(`Usage field is invalid: ${key}`);
	}
	return structuredClone(entry);
}

function assertBoundedJson(value: unknown, depth = 0): void {
	if (value === undefined) throw new Error("Price snapshot contains an undefined value");
	if (depth > MAX_V2_JSON_DEPTH) throw new Error("Price snapshot is too deeply nested");
	if (typeof value === "string") {
		if (value.length > MAX_V2_STRING_LENGTH) throw new Error("Price snapshot string is too long");
	} else if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) throw new Error("Price snapshot number is invalid");
	} else if (Array.isArray(value)) {
		if (value.length > MAX_V2_ARRAY_ITEMS) throw new Error("Price snapshot array is too large");
		value.forEach((item) => assertBoundedJson(item, depth + 1));
	} else if (value !== null && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length > MAX_V2_ARRAY_ITEMS) throw new Error("Price snapshot object is too large");
		entries.forEach(([key, item]) => {
			if (key.length > MAX_V2_STRING_LENGTH) throw new Error("Price snapshot key is too long");
			assertBoundedJson(item, depth + 1);
		});
	} else if (value !== null) {
		throw new Error("Price snapshot contains an unsupported value");
	}
}

function matches(entry: V2UsageLedgerEntry, filter: V2UsageFilter = {}): boolean {
	return Object.entries(filter).every(([key, value]) => entry[key as keyof V2UsageFilter] === value);
}

function aggregateEntries(entries: readonly V2UsageLedgerEntry[]): V2UsageAggregate {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	let imageUnits = 0;
	let costUsd = 0;
	let hasCost = true;
	let hasUnknown = false;
	let hasSubscription = false;
	for (const entry of entries) {
		input += entry.input;
		output += entry.output;
		cacheRead += entry.cacheRead;
		cacheWrite += entry.cacheWrite;
		reasoning += entry.reasoning ?? 0;
		imageUnits += entry.imageUnits ?? 0;
		if (entry.costUsd === undefined) hasCost = false;
		else costUsd += entry.costUsd;
		if (![input, output, cacheRead, cacheWrite, reasoning, imageUnits, costUsd].every(Number.isFinite))
			throw new Error("Usage aggregate exceeds numeric limits");
		if (entry.pricing === "unknown") hasUnknown = true;
		if (entry.pricing === "subscription") hasSubscription = true;
	}
	return {
		responses: entries.length,
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning,
		imageUnits,
		...(hasCost ? { costUsd } : {}),
		pricingState: hasUnknown ? "unknown" : hasSubscription ? "subscription" : "known",
	};
}

export class InMemoryV2UsageLedger implements V2UsageLedger {
	private readonly entries = new Map<string, V2UsageLedgerEntry>();

	replace(entries: readonly V2UsageLedgerEntry[]): void {
		this.entries.clear();
		for (const entry of entries) this.entries.set(entry.responseId, structuredClone(entry));
	}

	async record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry> {
		const validated = validateEntry(entry);
		this.entries.set(validated.responseId, validated);
		return structuredClone(validated);
	}

	async read(filter: V2UsageFilter = {}): Promise<readonly V2UsageLedgerEntry[]> {
		return [...this.entries.values()]
			.filter((entry) => matches(entry, filter))
			.map((entry) => structuredClone(entry));
	}

	async aggregate(filter: V2UsageFilter = {}): Promise<V2UsageAggregate> {
		return aggregateEntries(await this.read(filter));
	}
}

/** Durable usage ledger using serialized JSONL upserts keyed by provider response ID. */
export class JsonlV2UsageLedger implements V2UsageLedger {
	private readonly memory = new InMemoryV2UsageLedger();
	private readonly path: string;
	private pending: Promise<void> = Promise.resolve();
	private loaded = false;

	constructor(path: string) {
		this.path = path;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		let contents: string;
		try {
			if ((await lstat(this.path)).isSymbolicLink()) throw new Error("Usage ledger path must not be a symlink");
			if ((await stat(this.path)).size > MAX_LEDGER_FILE_BYTES) throw new Error("Usage ledger exceeds maximum size");
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.loaded = true; return; }
			throw error;
		}
		const recovered: V2UsageLedgerEntry[] = [];
		for (const line of contents.split("\n").filter(Boolean)) recovered.push(validateEntry(JSON.parse(line) as V2UsageLedgerEntry));
		this.memory.replace(recovered);
		this.loaded = true;
	}

	async record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry> {
		const write = this.pending.then(async () => {
			await this.ensureLoaded();
			const before = await this.memory.read();
			try {
			const validated = await this.memory.record(entry);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await chmod(dirname(this.path), 0o700);
			try { if ((await lstat(this.path)).isSymbolicLink()) throw new Error("Usage ledger path must not be a symlink"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.memory.replace(before); throw error; } }
			const serialized = `${JSON.stringify(validated)}\n`;
			try { if ((await stat(this.path)).size + Buffer.byteLength(serialized) > MAX_LEDGER_FILE_BYTES) throw new Error("Usage ledger exceeds maximum size"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.memory.replace(before); throw error; } }
			const handle = await open(this.path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try {
				await handle.write(serialized, undefined, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return validated;
			} catch (error) {
				this.memory.replace(before);
				throw error;
			}
		});
		this.pending = write.then(
			() => undefined,
			() => undefined,
		);
		return structuredClone(await write);
	}

	async read(filter: V2UsageFilter = {}): Promise<readonly V2UsageLedgerEntry[]> {
		await this.pending;
		await this.ensureLoaded();
		return this.memory.read(filter);
	}

	async aggregate(filter: V2UsageFilter = {}): Promise<V2UsageAggregate> {
		return aggregateEntries(await this.read(filter));
	}
}
