import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
	readonly maxFiles?: number;
}

/** Bounded owner-only JSONL evidence retained by a client before and during transport use. */
export class ClientDiagnosticSpool {
	readonly path: string;
	readonly clientInstanceId: string;
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly maxFiles: number;
	private records: ClientDiagnosticRecord[] = [];
	private nextSeq = 1;
	private loaded = false;
	private writeTail: Promise<void> = Promise.resolve();
	private currentBytes = 0;

	constructor(options: ClientDiagnosticSpoolOptions) {
		if (options.path.length === 0) throw new TypeError("Client diagnostic spool path must not be empty");
		if (options.clientInstanceId.length === 0)
			throw new TypeError("Client diagnostic clientInstanceId must not be empty");
		this.path = options.path;
		this.clientInstanceId = options.clientInstanceId;
		this.maxEntries = positiveLimit(options.maxEntries ?? 512, "maxEntries");
		this.maxBytes = positiveLimit(options.maxBytes ?? 512 * 1024, "maxBytes");
		this.maxFiles = positiveLimit(options.maxFiles ?? 3, "maxFiles");
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
		const trimmed = this.trim();
		await this.persist(record, trimmed);
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
		for (let index = this.maxFiles - 1; index >= 0; index--) {
			const filePath = index === 0 ? this.path : `${this.path}.${index}`;
			let text: string;
			try {
				text = await readFile(filePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (index === 0) this.currentBytes = Buffer.byteLength(text);
			this.records.push(
				...text
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
					}),
			);
		}
		this.records = this.records.sort((left, right) => left.seq - right.seq).slice(-this.maxEntries);
		this.nextSeq = (this.records.at(-1)?.seq ?? 0) + 1;
		this.trim();
	}

	private trim(): boolean {
		let trimmed = false;
		while (this.records.length > this.maxEntries) {
			this.records.shift();
			trimmed = true;
		}
		return trimmed;
	}

	private persist(record: ClientDiagnosticRecord, trimmed: boolean): Promise<void> {
		this.writeTail = this.writeTail.then(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const line = `${JSON.stringify(record)}\n`;
			if (trimmed) {
				await this.clearRotated();
				const content = `${this.records.map((item) => JSON.stringify(item)).join("\n")}\n`;
				await writeFile(this.path, content, { mode: 0o600 });
				this.currentBytes = Buffer.byteLength(content);
			} else {
				if (this.currentBytes > 0 && this.currentBytes + Buffer.byteLength(line) > this.maxBytes) {
					await this.rotate();
				}
				const handle = await open(this.path, "a", 0o600);
				try {
					await handle.write(line, undefined, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				this.currentBytes += Buffer.byteLength(line);
			}
			await chmod(this.path, 0o600);
		});
		return this.writeTail;
	}

	private async rotate(): Promise<void> {
		for (let index = this.maxFiles - 1; index >= 2; index--) {
			try {
				await rename(`${this.path}.${index - 1}`, `${this.path}.${index}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		try {
			await rename(this.path, `${this.path}.1`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.currentBytes = 0;
	}

	private async clearRotated(): Promise<void> {
		for (let index = 1; index < this.maxFiles; index++) {
			try {
				await unlink(`${this.path}.${index}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}

function positiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
	return value;
}
