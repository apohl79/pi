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
				appliedMigrations: ["001_initial.sql"],
				schemaVersion: "001_initial.sql",
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
			expect(report.inspection.schemaVersion).toBe("001_initial.sql");
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
