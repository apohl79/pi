import { chmod, lstat, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants, randomUUID } from "node:fs";
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

const SENSITIVE_KEY_PARTS = [
	"apikey",
	"authorization",
	"auth",
	"credential",
	"password",
	"secret",
	"token",
	"privatekey",
];
const MAX_DIAGNOSTIC_EVENTS = 10_000;
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_ITEMS = 10_000;
const MAX_DIAGNOSTIC_STRING = 1_048_576;
const MAX_DIAGNOSTIC_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_PAYLOAD_BYTES = 1 * 1024 * 1024;

const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, "").toLowerCase();

const isSensitiveKey = (key: string): boolean => {
	const normalized = normalizeKey(key);
	return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
};

const isCredentialShaped = (value: string): boolean =>
	/\bbearer\s+[a-z0-9._~+/=-]{8,}\b/i.test(value) ||
	/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i.test(value) ||
	/\b(?:sk|pk|rk)-[a-z0-9_-]{8,}\b/i.test(value) ||
	/\bAIza[0-9A-Za-z_-]{20,}\b/.test(value) ||
	/\bgh[pours]_[A-Za-z0-9_]{20,}\b/.test(value) ||
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(value);

function redact(value: unknown, key?: string, depth = 0): DiagnosticValue {
	if (key !== undefined && isSensitiveKey(key)) return "[REDACTED]";
	if (depth > MAX_DIAGNOSTIC_DEPTH) return "[TRUNCATED]";
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return isCredentialShaped(value) ? "[REDACTED]" : value.slice(0, MAX_DIAGNOSTIC_STRING);
	if (Array.isArray(value)) return value.slice(0, MAX_DIAGNOSTIC_ITEMS).map((item) => redact(item, undefined, depth + 1));
	if (typeof value === "object") {
		const output: Record<string, DiagnosticValue> = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_DIAGNOSTIC_ITEMS))
			output[childKey.slice(0, MAX_DIAGNOSTIC_STRING)] = redact(childValue, childKey, depth + 1);
		return output;
	}
	return "[UNSERIALIZABLE]";
}

function boundedEvent(input: ForensicEventInput, seq: number): ForensicEvent {
	let payload = redact(input.payload ?? {}) as Record<string, DiagnosticValue>;
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_DIAGNOSTIC_PAYLOAD_BYTES)
		payload = { _truncated: "Diagnostic payload exceeded the maximum size" };
	return {
		kind: input.kind.slice(0, MAX_DIAGNOSTIC_STRING),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId.slice(0, MAX_DIAGNOSTIC_STRING) }),
		...(input.operationId === undefined ? {} : { operationId: input.operationId.slice(0, MAX_DIAGNOSTIC_STRING) }),
		seq,
		timestamp: Date.now(),
		payload,
	};
}

export class InMemoryForensicRecorder implements ForensicRecorder {
	private readonly events: ForensicEvent[] = [];
	private readonly maxEvents: number;
	private nextSeq = 1;

	constructor(options: { maxEvents?: number } = {}) {
		const maxEvents = options.maxEvents ?? 2_048;
		if (!Number.isFinite(maxEvents) || !Number.isInteger(maxEvents) || maxEvents < 1)
			throw new Error("maxEvents must be a finite integer greater than or equal to 1");
		if (maxEvents > MAX_DIAGNOSTIC_EVENTS) throw new Error(`maxEvents must not exceed ${MAX_DIAGNOSTIC_EVENTS}`);
		this.maxEvents = maxEvents;
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const event = boundedEvent(input, this.nextSeq++);
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
		if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > MAX_DIAGNOSTIC_EVENTS)
			throw new Error(`maxEvents must be a positive integer no larger than ${MAX_DIAGNOSTIC_EVENTS}`);
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.loaded = true;
				return;
			}
			throw error;
		}
		const recovered: ForensicEvent[] = [];
		for (const line of contents.split("\n").filter(Boolean)) {
			const event = JSON.parse(line) as ForensicEvent;
			if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error("Invalid forensic sequence");
			recovered.push(event);
			this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
		}
		this.events.splice(0, this.events.length, ...recovered);
		if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
		this.loaded = true;
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const write = this.pendingWrite.then(async () => {
			await this.ensureLoaded();
			const previousEvents = this.events.slice();
			const previousNextSeq = this.nextSeq;
			try {
			const event = boundedEvent(input, this.nextSeq++);
			const wasFull = this.events.length >= this.maxEvents;
			this.events.push(event);
			if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await chmod(dirname(this.path), 0o700);
			try {
				if ((await lstat(this.path)).isSymbolicLink()) throw new Error("Diagnostic journal path must not be a symlink");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try { await chmod(this.path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const serializedEvent = `${JSON.stringify(event)}\n`;
			try {
				if ((await stat(this.path)).size + Buffer.byteLength(serializedEvent) > MAX_DIAGNOSTIC_FILE_BYTES)
					throw new Error("Diagnostic journal exceeds maximum size");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!wasFull) {
				const handle = await open(this.path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
				try {
					await handle.write(serializedEvent, undefined, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
			} else {
				const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
				const compacted = `${this.events.map((item) => JSON.stringify(item)).join("\n")}\n`;
				if (Buffer.byteLength(compacted) > MAX_DIAGNOSTIC_FILE_BYTES) throw new Error("Diagnostic journal exceeds maximum size");
				await writeFile(temporary, compacted, {
					mode: 0o600,
				});
				await rename(temporary, this.path);
			}
			return event;
			} catch (error) {
				this.events.splice(0, this.events.length, ...previousEvents);
				this.nextSeq = previousNextSeq;
				throw error;
			}
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
