import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "@earendil-works/pi-protocol";

export type ClientDiagnosticSeverity = "debug" | "info" | "warn" | "error";

export interface ClientDiagnosticRecordInput {
	readonly event: string;
	readonly severity?: ClientDiagnosticSeverity;
	readonly fields?: Record<string, JsonValue>;
	readonly timestamp?: number;
}

export interface ClientDiagnosticRecord extends ClientDiagnosticRecordInput {
	readonly schemaVersion: 1;
	readonly seq: number;
	readonly clientInstanceId: string;
	readonly severity: ClientDiagnosticSeverity;
	readonly timestamp: number;
}

export interface ClientDiagnosticSpoolOptions {
	readonly path: string;
	readonly clientInstanceId: string;
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

/** Bounded owner-only JSONL evidence retained by a client before and during transport use. */
export class ClientDiagnosticSpool {
	readonly path: string;
	readonly clientInstanceId: string;
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private records: ClientDiagnosticRecord[] = [];
	private nextSeq = 1;
	private loaded = false;
	private writeTail: Promise<void> = Promise.resolve();

	constructor(options: ClientDiagnosticSpoolOptions) {
		if (options.path.length === 0) throw new TypeError("Client diagnostic spool path must not be empty");
		if (options.clientInstanceId.length === 0)
			throw new TypeError("Client diagnostic clientInstanceId must not be empty");
		this.path = options.path;
		this.clientInstanceId = options.clientInstanceId;
		this.maxEntries = positiveLimit(options.maxEntries ?? 512, "maxEntries");
		this.maxBytes = positiveLimit(options.maxBytes ?? 512 * 1024, "maxBytes");
	}

	async append(input: ClientDiagnosticRecordInput): Promise<ClientDiagnosticRecord> {
		await this.ensureLoaded();
		const record: ClientDiagnosticRecord = {
			schemaVersion: 1,
			seq: this.nextSeq++,
			clientInstanceId: this.clientInstanceId,
			event: input.event,
			severity: input.severity ?? "info",
			timestamp: input.timestamp ?? Date.now(),
			...(input.fields === undefined ? {} : { fields: structuredClone(input.fields) }),
		};
		this.records.push(record);
		this.trim();
		await this.persist();
		return structuredClone(record);
	}

	async read(afterSeq = 0, limit = this.maxEntries): Promise<readonly ClientDiagnosticRecord[]> {
		await this.ensureLoaded();
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
			throw new TypeError("afterSeq must be a non-negative safe integer");
		const boundedLimit = positiveLimit(Math.min(limit, this.maxEntries), "limit");
		return this.records
			.filter((record) => record.seq > afterSeq)
			.slice(0, boundedLimit)
			.map((record) => structuredClone(record));
	}

	async latestSeq(): Promise<number> {
		await this.ensureLoaded();
		return this.records.at(-1)?.seq ?? 0;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const text = await readFile(this.path, "utf8");
			this.records = text
				.split("\n")
				.filter((line) => line.length > 0)
				.flatMap((line) => {
					try {
						const record = JSON.parse(line) as ClientDiagnosticRecord;
						return record.schemaVersion === 1 && record.clientInstanceId === this.clientInstanceId
							? [record]
							: [];
					} catch {
						return [];
					}
				})
				.slice(-this.maxEntries);
			this.nextSeq = (this.records.at(-1)?.seq ?? 0) + 1;
			this.trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private trim(): void {
		while (
			this.records.length > this.maxEntries ||
			Buffer.byteLength(`${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`) > this.maxBytes
		) {
			this.records.shift();
		}
	}

	private persist(): Promise<void> {
		const content = `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		this.writeTail = this.writeTail.then(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await writeFile(this.path, content, { mode: 0o600 });
			await chmod(this.path, 0o600);
		});
		return this.writeTail;
	}
}

function positiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
	return value;
}
