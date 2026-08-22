import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "@earendil-works/pi-protocol";

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

export function validateV2UsageEntry(entry: V2UsageLedgerEntry): V2UsageLedgerEntry {
	if (!entry.responseId || !entry.sessionId || !entry.agentId || !entry.operationId)
		throw new Error("Usage ledger identity fields are required");
	for (const [key, value] of Object.entries(entry)) {
		if (
			[
				"responseId",
				"sessionId",
				"agentId",
				"operationId",
				"turnId",
				"goalId",
				"purpose",
				"provider",
				"model",
				"pricing",
				"priceSnapshot",
			].includes(key)
		)
			continue;
		if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
			throw new Error(`Usage field is invalid: ${key}`);
	}
	return structuredClone(entry);
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

export function aggregateV2UsageEntries(entries: readonly V2UsageLedgerEntry[]): V2UsageAggregate {
	return aggregateEntries(entries);
}

export class InMemoryV2UsageLedger implements V2UsageLedger {
	private readonly entries = new Map<string, V2UsageLedgerEntry>();

	async record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry> {
		const validated = validateV2UsageEntry(entry);
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
		this.loaded = true;
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const line of contents.split("\n").filter(Boolean))
			await this.memory.record(JSON.parse(line) as V2UsageLedgerEntry);
	}

	async record(entry: V2UsageLedgerEntry): Promise<V2UsageLedgerEntry> {
		const write = this.pending.then(async () => {
			await this.ensureLoaded();
			const validated = validateV2UsageEntry(entry);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const handle = await open(this.path, "a", 0o600);
			try {
				await handle.write(`${JSON.stringify(validated)}\n`, undefined, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.memory.record(validated);
			return validated;
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
