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

export interface DiagnosticRepairResult {
	readonly name: string;
	readonly ok: boolean;
	readonly details?: Record<string, DiagnosticValue>;
}

/** Executes only explicitly safe repairs of derived indexes or caches. */
export type DiagnosticRepairProvider = () => Promise<readonly DiagnosticRepairResult[]>;

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

export interface RemoteV2DiagnosticsTimeline {
	readonly events: readonly Record<string, unknown>[];
	readonly operations: readonly Record<string, unknown>[];
	readonly operationEvents: readonly Record<string, unknown>[];
	readonly usage?: Record<string, unknown>;
}

export interface RemoteV2UsageRead {
	readonly aggregate: Record<string, unknown>;
	readonly entries: readonly Record<string, unknown>[];
}

/** Pure offline verifier for exported diagnostic bundles; it does not require a daemon or provider access. */
