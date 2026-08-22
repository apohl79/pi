import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelopeV2, OperationRecordV2 } from "@earendil-works/pi-protocol";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteV2OperationStore } from "../../src/server/sqlite-operation-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function operation(state: OperationRecordV2["state"] = "accepted"): OperationRecordV2 {
	return {
		operationId: "operation-1",
		sessionId: "session-1",
		state,
		accepted: { operationId: "operation-1", sessionRevision: 1, eventSeq: 1 },
	};
}

function event(sessionId: string, seq: number): EventEnvelopeV2 {
	return {
		type: "event",
		sessionId,
		seq,
		revision: seq,
		event: "operation_terminal",
		payload: { state: "complete" },
	};
}

describe("SqliteV2OperationStore", () => {
	test("serializes concurrent writes and restores operations and per-session events", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-operations-"));
		directories.push(directory);
		const path = join(directory, "operations.sqlite");
		const first = new SqliteV2OperationStore(createNodeSqliteFactory(), path);

		await Promise.all([
			first.putOperation(operation()),
			first.appendEvent(event("session-1", 1)),
			first.appendEvent(event("session-2", 1)),
		]);
		await first.putOperation(operation("complete"));
		await first.close();

		const restored = new SqliteV2OperationStore(createNodeSqliteFactory(), path);
		expect(await restored.load()).toEqual({
			operations: [operation("complete")],
			events: [event("session-1", 1), event("session-2", 1)],
		});
		await restored.close();
	});

	test("creates a SQLite journal with protocol-independent event ordering", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-operations-schema-"));
		directories.push(directory);
		const store = new SqliteV2OperationStore(createNodeSqliteFactory(), join(directory, "operations.sqlite"));
		await store.appendEvent({ ...event("session-1", 2), revision: 8 });
		await store.appendEvent({ ...event("session-1", 1), revision: 7 });
		expect((await store.load()).events.map((item) => item.revision)).toEqual([8, 7]);
		await store.close();
	});
});
