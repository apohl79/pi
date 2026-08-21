import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
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

export interface DiagnosticIntegrityCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly details?: Record<string, DiagnosticValue>;
}

export type DiagnosticIntegrityProvider = () => Promise<readonly DiagnosticIntegrityCheck[]>;

export interface DiagnosticCapsule {
	schemaVersion: 1;
	eventId: string;
	kind: string;
	keyId: string;
	nonce: string;
	ciphertext: string;
	authTag: string;
	plaintextSha256: string;
	byteLength: number;
	originalByteLength: number;
	truncated: boolean;
}

export interface DiagnosticCapsuleInput {
	eventId: string;
	kind: string;
	content: string | Uint8Array;
	maxBytes?: number;
}

export interface DiagnosticContentStore {
	encrypt(input: DiagnosticCapsuleInput): Promise<DiagnosticCapsule>;
	save?(capsule: DiagnosticCapsule): Promise<void>;
	list?(): Promise<readonly DiagnosticCapsule[]>;
}

export interface DiagnosticBundleVerification {
	valid: boolean;
	reason?: string;
}

export interface DiagnosticRuntimeManifest {
	readonly schemaVersion: 1;
	readonly runtime: string;
	readonly platform: string;
	readonly arch: string;
	readonly buildVersion?: string;
	readonly forkCommit?: string;
	readonly upstreamBaseCommit?: string;
	readonly configHash?: string;
}

/** Pure offline verifier for exported diagnostic bundles; it does not require a daemon or provider access. */
export function verifyDiagnosticBundle(value: unknown): DiagnosticBundleVerification {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { valid: false, reason: "diagnostic bundle must be an object" };
	const candidate = value as Record<string, unknown>;
	const events = candidate.events;
	const manifest = candidate.manifest;
	if (!Array.isArray(events) || typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
		return { valid: false, reason: "diagnostics/verify bundle requires events and manifest" };
	const capsules = candidate.capsules;
	if (
		capsules !== undefined &&
		(!Array.isArray(capsules) || capsules.some((capsule) => !isDiagnosticCapsule(capsule)))
	)
		return { valid: false, reason: "Diagnostic bundle contains an invalid capsule" };
	const runtimeManifest = candidate.runtimeManifest;
	if (runtimeManifest !== undefined && !isDiagnosticRuntimeManifest(runtimeManifest))
		return { valid: false, reason: "Diagnostic bundle contains an invalid runtime manifest" };
	const fields = manifest as Record<string, unknown>;
	const serializedEvents = JSON.stringify(events);
	const digest = createHash("sha256").update(serializedEvents).digest("hex");
	const firstSeq = events.length === 0 ? 0 : eventSequence(events[0]);
	const lastSeq = events.length === 0 ? 0 : eventSequence(events[events.length - 1]);
	const contiguous = events.every((event, index) => {
		const seq = eventSequence(event);
		return seq !== undefined && (index === 0 || seq === eventSequence(events[index - 1])! + 1);
	});
	const valid =
		fields.schemaVersion === 1 &&
		fields.eventCount === events.length &&
		fields.firstSeq === firstSeq &&
		fields.lastSeq === lastSeq &&
		fields.eventsSha256 === digest &&
		contiguous;
	return valid ? { valid: true } : { valid: false, reason: "Diagnostic bundle manifest does not match its events" };
}

function isDiagnosticRuntimeManifest(value: unknown): value is DiagnosticRuntimeManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const manifest = value as Record<string, unknown>;
	return (
		manifest.schemaVersion === 1 &&
		typeNonEmpty(manifest.runtime) &&
		typeNonEmpty(manifest.platform) &&
		typeNonEmpty(manifest.arch) &&
		["buildVersion", "forkCommit", "upstreamBaseCommit", "configHash"].every(
			(key) => manifest[key] === undefined || typeNonEmpty(manifest[key]),
		)
	);
}

function isDiagnosticCapsule(value: unknown): value is DiagnosticCapsule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const capsule = value as Record<string, unknown>;
	return (
		capsule.schemaVersion === 1 &&
		typeNonEmpty(capsule.eventId) &&
		typeNonEmpty(capsule.kind) &&
		typeNonEmpty(capsule.keyId) &&
		typeNonEmpty(capsule.nonce) &&
		typeNonEmpty(capsule.ciphertext) &&
		typeNonEmpty(capsule.authTag) &&
		typeNonEmpty(capsule.plaintextSha256) &&
		/^[a-f0-9]{64}$/u.test(capsule.plaintextSha256) &&
		Number.isSafeInteger(capsule.byteLength) &&
		Number.isSafeInteger(capsule.originalByteLength) &&
		(capsule.byteLength as number) >= 0 &&
		(capsule.originalByteLength as number) >= (capsule.byteLength as number) &&
		typeBoolean(capsule.truncated)
	);
}

function typeNonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function typeBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function eventSequence(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const seq = (value as Record<string, unknown>).seq;
	return Number.isInteger(seq) && (seq as number) >= 1 ? (seq as number) : undefined;
}

interface DiagnosticKeyFile {
	currentKeyId: string;
	keys: Record<string, string>;
}

interface DiagnosticCapsuleFile {
	capsules: DiagnosticCapsule[];
}

/** Local authenticated evidence store; key material stays in its owner-only key file, never in capsules. */
export class LocalDiagnosticCapsuleStore {
	private readonly keyPath: string;
	private readonly capsulePath: string;
	private readonly defaultMaxBytes: number;
	private readonly maxCapsules: number;
	private loaded = false;
	private currentKeyId = "";
	private readonly keys = new Map<string, Buffer>();
	private capsules: DiagnosticCapsule[] = [];
	private capsulesLoaded = false;

	constructor(keyPath: string, options: { maxBytes?: number; capsulePath?: string; maxCapsules?: number } = {}) {
		this.keyPath = keyPath;
		this.capsulePath = options.capsulePath ?? `${keyPath}.capsules`;
		this.defaultMaxBytes = options.maxBytes ?? 64 * 1024;
		this.maxCapsules = options.maxCapsules ?? 256;
	}

	async encrypt(input: DiagnosticCapsuleInput): Promise<DiagnosticCapsule> {
		await this.ensureLoaded();
		const original = Buffer.from(input.content);
		const maxBytes = input.maxBytes ?? this.defaultMaxBytes;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			throw new Error("Diagnostic capsule maxBytes must be positive");
		const plaintext = original.subarray(0, maxBytes);
		const truncated = plaintext.length < original.length;
		const nonce = randomBytes(12);
		const key = this.keys.get(this.currentKeyId);
		if (!key) throw new Error("Diagnostic capsule key is unavailable");
		const aad = capsuleAad(
			input.eventId,
			input.kind,
			this.currentKeyId,
			plaintext.length,
			original.length,
			truncated,
		);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			schemaVersion: 1,
			eventId: input.eventId,
			kind: input.kind,
			keyId: this.currentKeyId,
			nonce: nonce.toString("base64url"),
			ciphertext: ciphertext.toString("base64url"),
			authTag: cipher.getAuthTag().toString("base64url"),
			plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
			byteLength: plaintext.length,
			originalByteLength: original.length,
			truncated,
		};
	}

	async decrypt(capsule: DiagnosticCapsule): Promise<Uint8Array> {
		await this.ensureLoaded();
		if (capsule.schemaVersion !== 1) throw new Error("Unsupported diagnostic capsule schema");
		const key = this.keys.get(capsule.keyId);
		if (!key) throw new Error(`Diagnostic capsule key is unavailable: ${capsule.keyId}`);
		const nonce = Buffer.from(capsule.nonce, "base64url");
		const ciphertext = Buffer.from(capsule.ciphertext, "base64url");
		const aad = capsuleAad(
			capsule.eventId,
			capsule.kind,
			capsule.keyId,
			capsule.byteLength,
			capsule.originalByteLength,
			capsule.truncated,
		);
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(aad);
		decipher.setAuthTag(Buffer.from(capsule.authTag, "base64url"));
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		if (plaintext.length !== capsule.byteLength) throw new Error("Diagnostic capsule length mismatch");
		if (createHash("sha256").update(plaintext).digest("hex") !== capsule.plaintextSha256)
			throw new Error("Diagnostic capsule digest mismatch");
		return new Uint8Array(plaintext);
	}

	async save(capsule: DiagnosticCapsule): Promise<void> {
		await this.ensureCapsulesLoaded();
		this.capsules.push(capsule);
		if (this.capsules.length > this.maxCapsules) this.capsules.splice(0, this.capsules.length - this.maxCapsules);
		await this.persistCapsules();
	}

	async list(): Promise<readonly DiagnosticCapsule[]> {
		await this.ensureCapsulesLoaded();
		return this.capsules.map((capsule) => structuredClone(capsule));
	}

	async rotateKey(): Promise<string> {
		await this.ensureLoaded();
		this.currentKeyId = randomUUID();
		this.keys.set(this.currentKeyId, randomBytes(32));
		await this.persistKeys();
		return this.currentKeyId;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		let file: DiagnosticKeyFile | undefined;
		try {
			file = JSON.parse(await readFile(this.keyPath, "utf8")) as DiagnosticKeyFile;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (file?.currentKeyId && file.keys) {
			this.currentKeyId = file.currentKeyId;
			for (const [id, encoded] of Object.entries(file.keys)) this.keys.set(id, Buffer.from(encoded, "base64url"));
			if (this.keys.has(this.currentKeyId)) return;
		}
		this.currentKeyId = randomUUID();
		this.keys.set(this.currentKeyId, randomBytes(32));
		await this.persistKeys();
	}

	private async persistKeys(): Promise<void> {
		await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
		const temporary = `${this.keyPath}.${process.pid}.tmp`;
		const file: DiagnosticKeyFile = {
			currentKeyId: this.currentKeyId,
			keys: Object.fromEntries([...this.keys].map(([id, key]) => [id, key.toString("base64url")])),
		};
		await writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
		await rename(temporary, this.keyPath);
	}

	private async ensureCapsulesLoaded(): Promise<void> {
		if (this.capsulesLoaded) return;
		this.capsulesLoaded = true;
		try {
			const file = JSON.parse(await readFile(this.capsulePath, "utf8")) as DiagnosticCapsuleFile;
			if (Array.isArray(file.capsules)) this.capsules = file.capsules.slice(-this.maxCapsules);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async persistCapsules(): Promise<void> {
		await mkdir(dirname(this.capsulePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.capsulePath}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ capsules: this.capsules })}\n`, { mode: 0o600 });
		await rename(temporary, this.capsulePath);
	}
}

function capsuleAad(
	eventId: string,
	kind: string,
	keyId: string,
	byteLength: number,
	originalByteLength: number,
	truncated: boolean,
): Buffer {
	return Buffer.from(
		`${eventId}\0${kind}\0${keyId}\0${byteLength}\0${originalByteLength}\0${truncated ? 1 : 0}`,
		"utf8",
	);
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
