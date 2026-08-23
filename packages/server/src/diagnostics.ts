import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DiagnosticValue = null | boolean | number | string | DiagnosticValue[] | { [key: string]: DiagnosticValue };

export interface ForensicEventInput {
	kind: string;
	sessionId?: string;
	operationId?: string;
	payload?: Record<string, unknown>;
}

export interface ForensicEvent extends ForensicEventInput {
	seq: number;
	timestamp: number;
	payload: Record<string, DiagnosticValue>;
}

export interface ForensicRecorder {
	record(event: ForensicEventInput): Promise<ForensicEvent>;
	read(afterSeq?: number): Promise<ForensicEvent[]>;
}

const SENSITIVE_KEY_PARTS = ["apikey", "authorization", "credential", "password", "secret", "token", "privatekey"];

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_]/g, "");
	return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function isCredentialShaped(value: string): boolean {
	return (
		/\bbearer\s+[a-z0-9._~+/=-]{8,}\b/i.test(value) ||
		/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i.test(value) ||
		/\b(?:sk|pk|rk)-[a-z0-9_-]{8,}\b/i.test(value)
	);
}

function redact(value: unknown, key?: string): DiagnosticValue {
	if (key !== undefined && isSensitiveKey(key)) return "[REDACTED]";
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return isCredentialShaped(value) ? "[REDACTED]" : value;
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (typeof value === "object") {
		const output: Record<string, DiagnosticValue> = {};
		for (const [childKey, childValue] of Object.entries(value)) output[childKey] = redact(childValue, childKey);
		return output;
	}
	return "[UNSERIALIZABLE]";
}

export class InMemoryForensicRecorder implements ForensicRecorder {
	private readonly events: ForensicEvent[] = [];
	private readonly maxEvents: number;
	private nextSeq = 1;

	constructor(options: { maxEvents?: number } = {}) {
		this.maxEvents = options.maxEvents ?? 2_048;
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const event: ForensicEvent = {
			...input,
			seq: this.nextSeq++,
			timestamp: Date.now(),
			payload: redact(input.payload ?? {}) as Record<string, DiagnosticValue>,
		};
		this.events.push(event);
		if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
		return structuredClone(event);
	}

	async read(afterSeq = 0): Promise<ForensicEvent[]> {
		return structuredClone(this.events.filter((event) => event.seq > afterSeq));
	}
}

/** Append-only forensic recorder that recovers sequence state after daemon restart. */
export class JsonlForensicRecorder implements ForensicRecorder {
	private readonly path: string;
	private readonly maxEvents: number;
	private readonly events: ForensicEvent[] = [];
	private pendingWrite: Promise<void> = Promise.resolve();
	private loaded = false;
	private nextSeq = 1;

	constructor(path: string, options: { maxEvents?: number } = {}) {
		this.path = path;
		this.maxEvents = options.maxEvents ?? 2_048;
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
		for (const line of contents.split("\n").filter(Boolean)) {
			const event = JSON.parse(line) as ForensicEvent;
			if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error("Invalid forensic sequence");
			this.events.push(event);
			this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
		}
		if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const write = this.pendingWrite.then(async () => {
			await this.ensureLoaded();
			const event: ForensicEvent = {
				...input,
				seq: this.nextSeq++,
				timestamp: Date.now(),
				payload: redact(input.payload ?? {}) as Record<string, DiagnosticValue>,
			};
			const wasFull = this.events.length >= this.maxEvents;
			this.events.push(event);
			if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			if (!wasFull) {
				const handle = await open(this.path, "a", 0o600);
				try {
					await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
			} else {
				const temporary = `${this.path}.${process.pid}.tmp`;
				await writeFile(temporary, `${this.events.map((item) => JSON.stringify(item)).join("\n")}\n`, {
					mode: 0o600,
				});
				await rename(temporary, this.path);
			}
			return event;
		});
		this.pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return structuredClone(await write);
	}

	async read(afterSeq = 0): Promise<ForensicEvent[]> {
		await this.pendingWrite;
		await this.ensureLoaded();
		return structuredClone(this.events.filter((event) => event.seq > afterSeq));
	}
}
