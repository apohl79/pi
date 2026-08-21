import { open, readFile } from "node:fs/promises";

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export type OperationRecordV2 = Readonly<{
	operationId: string;
	sessionId: string;
	state: "accepted" | "running" | "complete" | "failed" | "aborted" | "suspended";
	accepted: Readonly<{ operationId: string; sessionRevision: number; eventSeq: number }>;
	terminalSeq?: number;
	error?: string;
}>;

export type EventEnvelopeV2 = Readonly<{
	type: "event";
	sessionId: string;
	seq: number;
	revision: number;
	operationId?: string;
	event: string;
	payload: JsonValue;
}>;

export interface V2OperationStore {
	load(): Promise<{ operations: readonly OperationRecordV2[]; events: readonly EventEnvelopeV2[] }>;
	putOperation(record: OperationRecordV2): Promise<void>;
	appendEvent(event: EventEnvelopeV2): Promise<void>;
}

type StoreRecord =
	| { readonly kind: "operation"; readonly value: OperationRecordV2 }
	| { readonly kind: "event"; readonly value: EventEnvelopeV2 };

export class InMemoryV2OperationStore implements V2OperationStore {
	private readonly operations = new Map<string, OperationRecordV2>();
	private readonly events: EventEnvelopeV2[] = [];

	async load(): Promise<{ operations: readonly OperationRecordV2[]; events: readonly EventEnvelopeV2[] }> {
		return {
			operations: structuredClone([...this.operations.values()]),
			events: structuredClone(this.events),
		};
	}

	async putOperation(record: OperationRecordV2): Promise<void> {
		this.operations.set(record.operationId, structuredClone(record));
	}

	async appendEvent(event: EventEnvelopeV2): Promise<void> {
		this.events.push(structuredClone(event));
	}
}

export class JsonlV2OperationStore implements V2OperationStore {
	private readonly path: string;
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.path = path;
	}

	async load(): Promise<{ operations: readonly OperationRecordV2[]; events: readonly EventEnvelopeV2[] }> {
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return { operations: [], events: [] };
			throw error;
		}
		const operations = new Map<string, OperationRecordV2>();
		const events: EventEnvelopeV2[] = [];
		for (const line of contents.split("\n").filter(Boolean)) {
			const record = JSON.parse(line) as StoreRecord;
			if (record.kind === "operation") operations.set(record.value.operationId, record.value);
			else events.push(record.value);
		}
		return { operations: [...operations.values()], events };
	}

	async putOperation(record: OperationRecordV2): Promise<void> {
		await this.append({ kind: "operation", value: record });
	}

	async appendEvent(event: EventEnvelopeV2): Promise<void> {
		await this.append({ kind: "event", value: event });
	}

	private append(record: StoreRecord): Promise<void> {
		const snapshot = structuredClone(record);
		const write = this.pendingWrite.then(async () => {
			const handle = await open(this.path, "a", 0o600);
			try {
				await handle.write(`${JSON.stringify(snapshot)}\n`, undefined, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		});
		this.pendingWrite = write.catch(() => undefined);
		return write;
	}
}
