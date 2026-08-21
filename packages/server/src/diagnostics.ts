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

const SENSITIVE_KEYS = new Set([
	"apikey",
	"authorization",
	"auth",
	"credential",
	"password",
	"secret",
	"token",
	"accesstoken",
	"refreshtoken",
	"clientsecret",
	"bearertoken",
	"xapikey",
]);

const normalizeKey = (key: string): string => key.replace(/[^a-z0-9]/gi, "").toLowerCase();

function redact(value: unknown, key?: string): DiagnosticValue {
	if (key !== undefined && SENSITIVE_KEYS.has(normalizeKey(key))) return "[REDACTED]";
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return value;
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
