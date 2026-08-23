import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelopeV2, OperationRecordV2 } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { JsonlV2OperationStore } from "../src/operation-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	directories.length = 0;
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

		expect(restored.operations).toEqual([{ ...operation, state: "complete", terminalSeq: 3 }]);
		expect(restored.events).toEqual([event]);
	});

	test("ignores a torn final JSONL record but rejects interior corruption", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pis-operation-store-corrupt-"));
		directories.push(directory);
		const path = join(directory, "operations.jsonl");
		const operation: OperationRecordV2 = {
			operationId: "op-1",
			sessionId: "session-1",
			state: "accepted",
			accepted: { operationId: "op-1", sessionRevision: 2, eventSeq: 2 },
		};
		const encoded = JSON.stringify({ kind: "operation", value: operation });

		await writeFile(path, `${encoded}\n{"kind":"event"`, "utf8");
		expect((await new JsonlV2OperationStore(path).load()).operations).toEqual([operation]);

		await writeFile(path, `${encoded}\n{"kind":\n`, "utf8");
		await expect(new JsonlV2OperationStore(path).load()).rejects.toThrow();
	});
});
