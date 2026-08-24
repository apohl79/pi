import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

describe("SQLite maintenance", () => {
	it("reports the applied schema and a healthy canonical database", async () => {
		const root = createTempDir();
		const repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		try {
			expect(await repository.inspect()).toEqual({
				appliedMigrations: ["001_initial.sql", "002_registers.sql"],
				schemaVersion: "002_registers.sql",
				quickCheck: ["ok"],
				foreignKeyErrors: [],
				healthy: true,
			});
		} finally {
			await repository.close();
		}
	});

	it("creates an online backup that can be reopened and verified", async () => {
		const root = createTempDir();
		const repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: "sessions.sqlite",
		});
		try {
			const report = await repository.backup("backups/sessions.sqlite");
			expect(report.destinationPath).toBe(join(root, "backups/sessions.sqlite"));
			expect(report.inspection.healthy).toBe(true);
			expect(report.inspection.schemaVersion).toBe("002_registers.sql");
		} finally {
			await repository.close();
		}

		const backup = await createNodeSqliteFactory().open(join(root, "backups/sessions.sqlite"));
		try {
			expect(backup.prepare("SELECT COUNT(*) AS count FROM sessions").get<{ count: number }>()).toEqual({
				count: 0,
			});
		} finally {
			backup.close();
		}
	});

	it("preserves and verifies a pre-migration database before upgrading it", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const migrationBackupPath = join(root, "backups", "pre-migration.sqlite");
		const sqlite = createNodeSqliteFactory();
		const seed = await sqlite.open(databasePath);
		try {
			seed.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			seed
				.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
				.run("000_legacy.sql", "2026-01-01T00:00:00.000Z");
		} finally {
			seed.close();
		}

		const repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite,
			databasePath,
			migrationBackupPath,
		});
		try {
			expect((await repository.inspect()).schemaVersion).toBe("002_registers.sql");
		} finally {
			await repository.close();
		}

		const backup = await sqlite.open(migrationBackupPath);
		try {
			expect(backup.prepare("SELECT id FROM migrations ORDER BY id").all<{ id: string }>()).toEqual([
				{ id: "000_legacy.sql" },
			]);
			expect(
				backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all(),
			).toEqual([]);
		} finally {
			backup.close();
		}
	});

	it("repairs only derived branch caches after they are removed", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const env = new NodeExecutionEnv({ cwd: root });
		const repository = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repository.create({ cwd: root, id: "repair-session" });
		await session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "canonical" }],
			timestamp: Date.now(),
		});
		await repository.close();

		const corrupt = await sqlite.open(databasePath);
		try {
			corrupt.prepare("DELETE FROM branch_entries WHERE session_id = ?").run("repair-session");
			corrupt.prepare("DELETE FROM branch_tips WHERE session_id = ?").run("repair-session");
		} finally {
			corrupt.close();
		}

		const repaired = new SqliteSessionRepository({ env, sqlite, databasePath });
		try {
			expect(await repaired.repairDerivedIndexes()).toEqual(["repair-session"]);
			const inspection = await sqlite.open(databasePath);
			try {
				expect(
					inspection
						.prepare("SELECT COUNT(*) AS count FROM entries WHERE session_id = ?")
						.get<{ count: number }>("repair-session"),
				).toEqual({ count: 1 });
				expect(
					inspection
						.prepare("SELECT COUNT(*) AS count FROM branch_entries WHERE session_id = ?")
						.get<{ count: number }>("repair-session"),
				).toEqual({ count: 1 });
			} finally {
				inspection.close();
			}
		} finally {
			await repaired.close();
		}
	});
});
