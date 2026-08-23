import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type EventEnvelopeV2,
	InMemoryV2OperationStore,
	JsonlV2OperationStore,
	type OperationRecordV2,
} from "../src/operation-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
});

describe("InMemoryV2OperationStore", () => {
	test("deep-clones records returned by load", async () => {
		const store = new InMemoryV2OperationStore();
		const operation: OperationRecordV2 = {
			operationId: "op-1",
			sessionId: "session-1",
			state: "accepted",
			accepted: { operationId: "op-1", sessionRevision: 2, eventSeq: 2 },
		};
		const event: EventEnvelopeV2 = {
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "operation_accepted",
			payload: { details: { state: "accepted" } },
		};

		await store.putOperation(operation);
		await store.appendEvent(event);
		const loaded = await store.load();
		const loadedOperation = loaded.operations[0] as unknown as { accepted: { sessionRevision: number } };
		const loadedEvent = loaded.events[0] as unknown as { payload: { details: { state: string } } };
		loadedOperation.accepted.sessionRevision = 99;
		loadedEvent.payload.details.state = "changed";

		expect(await store.load()).toEqual({ operations: [operation], events: [event] });
	});
});

describe("JsonlV2OperationStore", () => {
	test("serializes concurrent critical writes and restores the latest operation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-operation-store-"));
		directories.push(directory);
		const store = new JsonlV2OperationStore(join(directory, "operations.jsonl"));
		const operation: OperationRecordV2 = {
			operationId: "op-1",
			sessionId: "session-1",
			state: "accepted",
			accepted: { operationId: "op-1", sessionRevision: 2, eventSeq: 2 },
		};
		const event: EventEnvelopeV2 = {
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			operationId: "op-1",
			event: "operation_accepted",
			payload: { state: "accepted" },
		};

		await Promise.all([store.putOperation(operation), store.appendEvent(event)]);
		await store.putOperation({ ...operation, state: "complete", terminalSeq: 3 });
		const restored = await new JsonlV2OperationStore(join(directory, "operations.jsonl")).load();
		const permissions = (await stat(join(directory, "operations.jsonl"))).mode & 0o777;

		expect(restored.operations).toEqual([{ ...operation, state: "complete", terminalSeq: 3 }]);
		expect(restored.events).toEqual([event]);
		expect(permissions).toBe(0o600);
	});

	test("preserves permissions on an existing JSONL file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-operation-store-"));
		directories.push(directory);
		const path = join(directory, "operations.jsonl");
		await writeFile(path, "", { mode: 0o640 });
		await chmod(path, 0o640);
		await new JsonlV2OperationStore(path).appendEvent({
			type: "event",
			sessionId: "session-1",
			seq: 1,
			revision: 1,
			event: "operation_accepted",
			payload: {},
		});

		expect((await stat(path)).mode & 0o777).toBe(0o640);
	});

	test("snapshots records before queued writes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-operation-store-"));
		directories.push(directory);
		const store = new JsonlV2OperationStore(join(directory, "operations.jsonl"));
		const event: EventEnvelopeV2 = {
			type: "event",
			sessionId: "session-1",
			seq: 1,
			revision: 1,
			event: "operation_accepted",
			payload: { details: { state: "accepted" } },
		};
		const expectedEvent = structuredClone(event);

		const write = store.appendEvent(event);
		(event as unknown as { payload: { details: { state: string } } }).payload.details.state = "changed";
		await write;

		expect((await store.load()).events).toEqual([expectedEvent]);
	});
});
