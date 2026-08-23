import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteForensicRecorder } from "../../src/server/sqlite-forensic-recorder.ts";

const directories: string[] = [];
afterEach(async () =>
	Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

describe("SqliteForensicRecorder", () => {
	test("restores sequence, redaction, and bounded reads after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-diagnostics-"));
		directories.push(directory);
		const path = join(directory, "diagnostics.sqlite");
		const first = new SqliteForensicRecorder(createNodeSqliteFactory(), path, { maxEvents: 2 });
		await first.record({ kind: "one", payload: { apiKey: "secret" } });
		await first.record({ kind: "two" });
		await first.record({ kind: "three" });
		expect((await first.read()).map((event) => event.kind)).toEqual(["two", "three"]);
		expect((await first.read())[1].payload).toEqual({});
		await first.close();

		const restored = new SqliteForensicRecorder(createNodeSqliteFactory(), path, { maxEvents: 2 });
		expect((await restored.read()).map((event) => event.seq)).toEqual([2, 3]);
		const event = await restored.record({ kind: "four" });
		expect(event.seq).toBe(4);
		await restored.close();
	});
});
