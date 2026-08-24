import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteSessionMetadata } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { WorkerSqliteSessionRepository } from "../../src/server/worker-sqlite-session-repository.ts";

const directories: string[] = [];
afterEach(async () =>
	Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

describe("WorkerSqliteSessionRepository", () => {
	test("persists a session through its worker-owned SQLite repository", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-worker-sessions-"));
		directories.push(directory);
		const path = join(directory, "sessions.sqlite");
		const first = new WorkerSqliteSessionRepository({ databasePath: path, cwd: directory });
		await expect(first.open({ id: "missing", cwd: directory, path })).rejects.toMatchObject({ code: "not_found" });
		const session = await first.create({ id: "session-1", cwd: directory });
		await session.appendCustomEntry("marker", { value: "persisted" });
		await first.close();

		const restored = new WorkerSqliteSessionRepository({ databasePath: path, cwd: directory });
		const metadata = (await restored.list()).find((item) => item.id === "session-1");
		expect(metadata).toBeDefined();
		const reopened = await restored.open(metadata as SqliteSessionMetadata);
		expect(await reopened.findEntries({ type: "custom" })).toMatchObject([
			{ customType: "marker", data: { value: "persisted" } },
		]);
		await restored.close();
	});
});
