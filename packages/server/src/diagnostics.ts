import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DiagnosticValue = null | boolean | number | string | DiagnosticValue[] | { [key: string]: DiagnosticValue };

export type DiagnosticSeverity = "debug" | "info" | "warn" | "error";
export type DiagnosticOutcome = "started" | "ok" | "error" | "cancelled" | "suspended" | "ambiguous";

export interface ForensicEventInput {
	kind: string;
	eventId?: string;
	severity?: DiagnosticSeverity;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	processInstanceId?: string;
	daemonInstanceId?: string;
	clientInstanceId?: string;
	sessionId?: string;
	operationId?: string;
	turnId?: string;
	agentId?: string;
	outcome?: DiagnosticOutcome;
	durationMs?: number;
	payload?: Record<string, unknown>;
}

export interface ForensicEvent extends ForensicEventInput {
	schemaVersion: 1;
	eventId: string;
	severity: DiagnosticSeverity;
	traceId: string;
	spanId: string;
	processInstanceId: string;
	seq: number;
	timestamp: number;
	payload: Record<string, DiagnosticValue>;
}

export interface DiagnosticClockDiscontinuity {
	readonly previousSeq: number;
	readonly seq: number;
	readonly previousTimestamp: number;
	readonly timestamp: number;
	readonly deltaMs: number;
}

/** Identifies backwards wall-clock jumps without changing sequence ordering. */
export function findDiagnosticClockDiscontinuities(
	events: readonly Pick<ForensicEvent, "seq" | "timestamp">[],
): readonly DiagnosticClockDiscontinuity[] {
	const discontinuities: DiagnosticClockDiscontinuity[] = [];
	for (let index = 1; index < events.length; index += 1) {
		const previous = events[index - 1]!;
		const current = events[index]!;
		if (current.timestamp >= previous.timestamp) continue;
		discontinuities.push({
			previousSeq: previous.seq,
			seq: current.seq,
			previousTimestamp: previous.timestamp,
			timestamp: current.timestamp,
			deltaMs: current.timestamp - previous.timestamp,
		});
	}
	return discontinuities;
}

export interface ForensicRecorder {
	record(event: ForensicEventInput): Promise<ForensicEvent>;
	read(afterSeq?: number): Promise<ForensicEvent[]>;
	/** Reports non-critical sink failures that make operational evidence incomplete. */
	isDegraded?(): boolean;
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
	decrypt?(capsule: DiagnosticCapsule): Promise<Uint8Array>;
	save?(capsule: DiagnosticCapsule): Promise<void>;
	list?(): Promise<readonly DiagnosticCapsule[]>;
}

export interface DiagnosticBundleVerification {
	valid: boolean;
	reason?: string;
}

export interface DiagnosticBundleManifest {
	readonly schemaVersion: 1;
	readonly eventCount: number;
	readonly firstSeq: number;
	readonly lastSeq: number;
	readonly eventsSha256: string;
	readonly capsulesSha256?: string;
	readonly projectionsSha256?: string;
	readonly scope?: DiagnosticBundleScope;
	readonly unavailable?: readonly string[];
}

export interface DiagnosticBundleScope {
	readonly sessionId?: string;
	readonly operationId?: string;
}

export interface DiagnosticBundleProjections {
	readonly sessions: readonly DiagnosticValue[];
	/** Server-authoritative snapshot for a session-scoped export, when it can be reconstructed. */
	readonly sessionSnapshots?: readonly DiagnosticValue[];
	readonly operations: readonly DiagnosticValue[];
	/** Canonical operation lifecycle events, when exported by a server that supports the projection. */
	readonly operationEvents?: readonly DiagnosticValue[];
	readonly usage: DiagnosticValue;
	readonly plugins: DiagnosticValue;
	readonly blobs: readonly DiagnosticValue[];
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
	if (candidate.integrity !== undefined && !isDiagnosticIntegrityReport(candidate.integrity))
		return { valid: false, reason: "Diagnostic bundle contains an invalid integrity report" };
	const projections = candidate.projections;
	if (projections !== undefined && !isDiagnosticProjections(projections))
		return { valid: false, reason: "Diagnostic bundle contains invalid canonical projections" };
	if (candidate.clientDiagnostics !== undefined && !isClientDiagnosticExport(candidate.clientDiagnostics))
		return { valid: false, reason: "Diagnostic bundle contains invalid client diagnostics" };
	const fields = manifest as Record<string, unknown>;
	const scope = fields.scope;
	if (scope !== undefined && !isDiagnosticBundleScope(scope))
		return { valid: false, reason: "Diagnostic bundle manifest contains an invalid scope" };
	if (
		fields.unavailable !== undefined &&
		(!Array.isArray(fields.unavailable) ||
			fields.unavailable.some((item) => typeof item !== "string" || item.length === 0))
	)
		return { valid: false, reason: "Diagnostic bundle manifest contains invalid unavailable entries" };
	const serializedEvents = JSON.stringify(events);
	const digest = createHash("sha256").update(serializedEvents).digest("hex");
	const serializedCapsules = JSON.stringify(capsules ?? []);
	const capsulesDigest = createHash("sha256").update(serializedCapsules).digest("hex");
	const serializedProjections = JSON.stringify(projections ?? {});
	const projectionsDigest = createHash("sha256").update(serializedProjections).digest("hex");
	const firstSeq = events.length === 0 ? 0 : eventSequence(events[0]);
	const lastSeq = events.length === 0 ? 0 : eventSequence(events[events.length - 1]);
	const contiguous = events.every((event, index) => {
		const seq = eventSequence(event);
		return seq !== undefined && (index === 0 || seq === eventSequence(events[index - 1])! + 1);
	});
	const scopedEvents =
		scope === undefined ||
		events.every((event) => {
			const scoped = scope as DiagnosticBundleScope;
			return (
				(scoped.sessionId === undefined || eventSessionId(event) === scoped.sessionId) &&
				(scoped.operationId === undefined || eventOperationId(event) === scoped.operationId)
			);
		});
	const scopedProjections =
		scope === undefined || projections === undefined || projectionsMatchScope(projections, scope);
	const valid =
		fields.schemaVersion === 1 &&
		fields.eventCount === events.length &&
		fields.firstSeq === firstSeq &&
		fields.lastSeq === lastSeq &&
		fields.eventsSha256 === digest &&
		(fields.capsulesSha256 === undefined || fields.capsulesSha256 === capsulesDigest) &&
		(fields.projectionsSha256 === undefined || fields.projectionsSha256 === projectionsDigest) &&
		scopedEvents &&
		scopedProjections &&
		(scope !== undefined || contiguous);
	return valid ? { valid: true } : { valid: false, reason: "Diagnostic bundle manifest does not match its events" };
}

function isDiagnosticBundleScope(value: unknown): value is DiagnosticBundleScope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const scope = value as Record<string, unknown>;
	const hasSession = scope.sessionId !== undefined;
	const hasOperation = scope.operationId !== undefined;
	return (
		(hasSession || hasOperation) &&
		(!hasSession || typeNonEmpty(scope.sessionId)) &&
		(!hasOperation || typeNonEmpty(scope.operationId))
	);
}

function isDiagnosticProjections(value: unknown): value is DiagnosticBundleProjections {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const projections = value as Record<string, unknown>;
	return (
		Array.isArray(projections.sessions) &&
		projections.sessions.every(isDiagnosticValue) &&
		(projections.sessionSnapshots === undefined ||
			(Array.isArray(projections.sessionSnapshots) && projections.sessionSnapshots.every(isDiagnosticValue))) &&
		Array.isArray(projections.operations) &&
		projections.operations.every(isDiagnosticValue) &&
		(projections.operationEvents === undefined ||
			(Array.isArray(projections.operationEvents) && projections.operationEvents.every(isDiagnosticValue))) &&
		isDiagnosticValue(projections.usage) &&
		isDiagnosticValue(projections.plugins) &&
		Array.isArray(projections.blobs) &&
		projections.blobs.every(isDiagnosticValue)
	);
}

function projectionsMatchScope(projections: DiagnosticBundleProjections, scope: DiagnosticBundleScope): boolean {
	if (
		scope.sessionId !== undefined &&
		!projections.sessions.every((session) => scopedRecordMatches(session, "id", scope.sessionId!))
	)
		return false;
	if (
		scope.sessionId !== undefined &&
		projections.sessionSnapshots !== undefined &&
		!projections.sessionSnapshots.every((snapshot) => scopedRecordMatches(snapshot, "id", scope.sessionId!))
	)
		return false;
	if (
		!projections.operations.every((operation) =>
			scopedRecordMatches(operation, "sessionId", scope.sessionId, scope.operationId),
		)
	)
		return false;
	if (
		projections.operationEvents !== undefined &&
		!projections.operationEvents.every((event) =>
			scopedRecordMatches(event, "sessionId", scope.sessionId, scope.operationId),
		)
	)
		return false;
	if (typeof projections.usage !== "object" || projections.usage === null || Array.isArray(projections.usage))
		return false;
	const usageEntries = (projections.usage as Record<string, unknown>).entries;
	return (
		Array.isArray(usageEntries) &&
		usageEntries.every((entry) => scopedRecordMatches(entry, "sessionId", scope.sessionId, scope.operationId))
	);
}

function scopedRecordMatches(
	value: unknown,
	primaryField: "id" | "sessionId",
	sessionId?: string,
	operationId?: string,
): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (sessionId !== undefined && record[primaryField] !== sessionId && record.sessionId !== sessionId) return false;
	return operationId === undefined || record.operationId === operationId;
}

function eventSessionId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const sessionId = (value as Record<string, unknown>).sessionId;
	return typeof sessionId === "string" ? sessionId : undefined;
}

function eventOperationId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const operationId = (value as Record<string, unknown>).operationId;
	return typeof operationId === "string" ? operationId : undefined;
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

function isClientDiagnosticExport(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const exportValue = value as Record<string, unknown>;
	if (!Number.isSafeInteger(exportValue.afterSeq) || (exportValue.afterSeq as number) < 0) return false;
	if (exportValue.records === undefined) {
		const manifest = exportValue.manifest;
		if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
		const fields = manifest as Record<string, unknown>;
		return (
			(fields.clientInstanceId === undefined || typeNonEmpty(fields.clientInstanceId)) &&
			typeNonEmpty(fields.runtime) &&
			typeNonEmpty(fields.platform) &&
			typeNonEmpty(fields.arch) &&
			(fields.buildVersion === undefined || typeNonEmpty(fields.buildVersion)) &&
			(fields.forkCommit === undefined || typeNonEmpty(fields.forkCommit)) &&
			(fields.upstreamBaseCommit === undefined || typeNonEmpty(fields.upstreamBaseCommit)) &&
			(fields.configHash === undefined || typeNonEmpty(fields.configHash))
		);
	}
	if (!Array.isArray(exportValue.records)) return false;
	return exportValue.records.every((record) => {
		if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
		const candidate = record as Record<string, unknown>;
		return (
			candidate.schemaVersion === 1 &&
			Number.isSafeInteger(candidate.seq) &&
			(candidate.seq as number) > 0 &&
			typeNonEmpty(candidate.clientInstanceId) &&
			typeNonEmpty(candidate.event) &&
			["debug", "info", "warn", "error"].includes(candidate.severity as string) &&
			Number.isSafeInteger(candidate.timestamp) &&
			(candidate.fields === undefined || (typeof candidate.fields === "object" && candidate.fields !== null))
		);
	});
}

function isDiagnosticIntegrityReport(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every((check) => {
			if (typeof check !== "object" || check === null || Array.isArray(check)) return false;
			const candidate = check as Record<string, unknown>;
			return (
				typeNonEmpty(candidate.name) &&
				typeBoolean(candidate.ok) &&
				(candidate.details === undefined || isDiagnosticValue(candidate.details))
			);
		})
	);
}

function isDiagnosticValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isDiagnosticValue);
	if (typeof value !== "object") return false;
	return Object.entries(value).every(([key, nested]) => key.length > 0 && isDiagnosticValue(nested));
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

function materializeEvent(
	input: ForensicEventInput,
	seq: number,
	timestamp: number,
	processInstanceId: string,
): ForensicEvent {
	return {
		...input,
		schemaVersion: 1,
		eventId: input.eventId ?? randomUUID(),
		severity: input.severity ?? "info",
		traceId: input.traceId ?? randomUUID(),
		spanId: input.spanId ?? randomUUID(),
		processInstanceId: input.processInstanceId ?? processInstanceId,
		seq,
		timestamp,
		payload: redact(input.payload ?? {}) as Record<string, DiagnosticValue>,
	};
}

export class InMemoryForensicRecorder implements ForensicRecorder {
	private readonly events: ForensicEvent[] = [];
	private readonly maxEvents: number;
	private readonly processInstanceId = randomUUID();
	private nextSeq = 1;

	constructor(options: { maxEvents?: number } = {}) {
		this.maxEvents = options.maxEvents ?? 2_048;
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const event = materializeEvent(input, this.nextSeq++, Date.now(), this.processInstanceId);
		this.events.push(event);
		if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
		return structuredClone(event);
	}

	async read(afterSeq = 0): Promise<ForensicEvent[]> {
		return structuredClone(this.events.filter((event) => event.seq > afterSeq));
	}

	isDegraded(): boolean {
		return false;
	}

	/** Rehydrates a previously materialized event for a durable recorder adapter. */
	restore(event: ForensicEvent): void {
		const validated = parseForensicEvent(event);
		this.events.push(structuredClone(validated));
		this.nextSeq = Math.max(this.nextSeq, validated.seq + 1);
		if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
	}
}

/** Append-only forensic recorder that recovers sequence state after daemon restart. */
export class JsonlForensicRecorder implements ForensicRecorder {
	private readonly path: string;
	private readonly maxEvents: number;
	private readonly maxBytes: number;
	private readonly maxFiles: number;
	private readonly events: ForensicEvent[] = [];
	private readonly processInstanceId = randomUUID();
	private pendingWrite: Promise<void> = Promise.resolve();
	private loaded = false;
	private nextSeq = 1;
	private currentBytes = 0;

	constructor(path: string, options: { maxEvents?: number; maxBytes?: number; maxFiles?: number } = {}) {
		this.path = path;
		this.maxEvents = options.maxEvents ?? 2_048;
		this.maxBytes = positiveLimit(options.maxBytes ?? Number.MAX_SAFE_INTEGER, "maxBytes");
		this.maxFiles = positiveLimit(options.maxFiles ?? 3, "maxFiles");
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		for (let index = this.maxFiles - 1; index >= 0; index--) {
			const filePath = index === 0 ? this.path : `${this.path}.${index}`;
			let contents: string;
			try {
				contents = await readFile(filePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (index === 0) this.currentBytes = Buffer.byteLength(contents);
			for (const line of contents.split("\n").filter(Boolean)) {
				const parsed = parseForensicEvent(JSON.parse(line));
				const event =
					parsed.schemaVersion === 1 && parsed.eventId !== undefined
						? parsed
						: materializeEvent(parsed, parsed.seq, parsed.timestamp, this.processInstanceId);
				this.events.push(event);
				this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
			}
		}
		if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const write = this.pendingWrite.then(async () => {
			await this.ensureLoaded();
			const event = materializeEvent(input, this.nextSeq++, Date.now(), this.processInstanceId);
			const wasFull = this.events.length >= this.maxEvents;
			this.events.push(event);
			if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			const line = `${JSON.stringify(event)}\n`;
			if (!wasFull && this.currentBytes > 0 && this.currentBytes + Buffer.byteLength(line) > this.maxBytes) {
				await this.rotate();
			}
			if (!wasFull) {
				const handle = await open(this.path, "a", 0o600);
				try {
					await handle.write(line, undefined, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				this.currentBytes += Buffer.byteLength(line);
			} else {
				const temporary = `${this.path}.${process.pid}.tmp`;
				const contents = `${this.events.map((item) => JSON.stringify(item)).join("\n")}\n`;
				await writeFile(temporary, contents, {
					mode: 0o600,
				});
				await rename(temporary, this.path);
				this.currentBytes = Buffer.byteLength(contents);
			}
			return event;
		});
		this.pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return structuredClone(await write);
	}

	private async rotate(): Promise<void> {
		for (let index = this.maxFiles - 1; index >= 2; index--) {
			const source = `${this.path}.${index - 1}`;
			const target = `${this.path}.${index}`;
			try {
				await rename(source, target);
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

	async read(afterSeq = 0): Promise<ForensicEvent[]> {
		await this.pendingWrite;
		await this.ensureLoaded();
		return structuredClone(this.events.filter((event) => event.seq > afterSeq));
	}
}

/** Mirrors critical events to a bounded operational log without making log failures block acceptance. */
export class TeeForensicRecorder implements ForensicRecorder {
	private readonly primary: ForensicRecorder;
	private readonly secondary: ForensicRecorder;
	private secondaryFailures = 0;

	constructor(primary: ForensicRecorder, secondary: ForensicRecorder) {
		this.primary = primary;
		this.secondary = secondary;
	}

	async record(input: ForensicEventInput): Promise<ForensicEvent> {
		const event = await this.primary.record(input);
		try {
			await this.secondary.record({
				...input,
				eventId: event.eventId,
				traceId: event.traceId,
				spanId: event.spanId,
				...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
			});
		} catch {
			this.secondaryFailures += 1;
			if (this.secondaryFailures === 1) {
				try {
					await this.primary.record({
						kind: "diagnostics_degraded",
						severity: "error",
						...(input.traceId === undefined ? {} : { traceId: input.traceId }),
						...(input.spanId === undefined ? {} : { spanId: input.spanId }),
						...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
						...(input.daemonInstanceId === undefined ? {} : { daemonInstanceId: input.daemonInstanceId }),
						...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
						...(input.operationId === undefined ? {} : { operationId: input.operationId }),
						outcome: "error",
						payload: { sink: "operational-log", failureCount: this.secondaryFailures },
					});
				} catch {
					// The degradation marker is best-effort when the canonical recorder is already failing.
				}
			}
		}
		return event;
	}

	read(afterSeq = 0): Promise<ForensicEvent[]> {
		return this.primary.read(afterSeq);
	}

	getOperationalLogFailureCount(): number {
		return this.secondaryFailures;
	}

	isDegraded(): boolean {
		return this.secondaryFailures > 0;
	}
}

function positiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
	return value;
}

function parseForensicEvent(value: unknown): ForensicEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid forensic event");
	const event = value as Record<string, unknown>;
	if (
		event.schemaVersion !== 1 ||
		!typeNonEmpty(event.eventId) ||
		!typeNonEmpty(event.kind) ||
		!typeNonEmpty(event.severity) ||
		!["debug", "info", "warn", "error"].includes(event.severity) ||
		!typeNonEmpty(event.traceId) ||
		!typeNonEmpty(event.spanId) ||
		!typeNonEmpty(event.processInstanceId) ||
		!Number.isSafeInteger(event.seq) ||
		(event.seq as number) < 1 ||
		!Number.isSafeInteger(event.timestamp) ||
		(event.timestamp as number) < 1 ||
		event.payload === undefined ||
		typeof event.payload !== "object" ||
		event.payload === null ||
		Array.isArray(event.payload) ||
		!Object.values(event.payload as Record<string, unknown>).every(isDiagnosticValue)
	)
		throw new Error("Invalid forensic event");
	for (const key of [
		"parentSpanId",
		"daemonInstanceId",
		"clientInstanceId",
		"sessionId",
		"operationId",
		"turnId",
		"agentId",
	])
		if (event[key] !== undefined && !typeNonEmpty(event[key])) throw new Error("Invalid forensic event");
	if (
		event.outcome !== undefined &&
		!["started", "ok", "error", "cancelled", "suspended", "ambiguous"].includes(event.outcome as string)
	)
		throw new Error("Invalid forensic event");
	if (
		event.durationMs !== undefined &&
		(typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs < 0)
	)
		throw new Error("Invalid forensic event");
	return event as unknown as ForensicEvent;
}
