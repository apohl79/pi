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

const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, "").toLowerCase();

const isSensitiveKey = (key: string): boolean => {
	const normalized = normalizeKey(key);
	return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
};

const isCredentialShaped = (value: string): boolean =>
	/\bbearer\s+[a-z0-9._~+/=-]{8,}\b/i.test(value) ||
	/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i.test(value) ||
	/\b(?:sk|pk|rk)-[a-z0-9_-]{8,}\b/i.test(value);

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
		const maxEvents = options.maxEvents ?? 2_048;
		if (!Number.isFinite(maxEvents) || !Number.isInteger(maxEvents) || maxEvents < 1)
			throw new Error("maxEvents must be a finite integer greater than or equal to 1");
		this.maxEvents = maxEvents;
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
