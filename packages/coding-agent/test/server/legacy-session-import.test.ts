import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, test } from "vitest";
import { importLegacySessions } from "../../src/server/legacy-session-import.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("legacy SQLite session import", () => {
	test("imports a JSONL session lazily with provenance and preserves the source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-legacy-import-"));
		directories.push(directory);
		const sessionsRoot = join(directory, "sessions");
		const sessionDirectory = join(sessionsRoot, `--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		const sourcePath = join(sessionDirectory, "2026-01-01T00-00-00-000Z_legacy-session.jsonl");
		const header = { kind: "header", version: 4, id: "legacy-session", createdAt: 1, cwd: directory };
		const entry = {
			kind: "entry",
			lane: "main",
			id: "legacy-entry",
			seq: 1,
			type: "message",
			parentId: null,
			timestamp: 2,
			message: { role: "user", content: "legacy prompt", timestamp: 2 },
		};
		await mkdir(sessionDirectory, { recursive: true });
		await writeFile(sourcePath, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
		const env = new NodeExecutionEnv({ cwd: directory });
		const repository = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(directory, "server.sqlite"),
		});
		try {
			const result = await importLegacySessions({ repository, fs: env, sessionsRoot });
			expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });
			const [metadata] = await repository.list();
			expect((await repository.verifyReopen()).healthy).toBe(true);
			expect(metadata?.metadata).toMatchObject({
				legacyImport: { version: 1, sourcePath, backupPath: expect.stringContaining(".legacy-backup-") },
			});
			const imported = await repository.open(metadata!);
			expect((await imported.findEntries({ order: "oldestFirst" })).map((item) => item.id)).toEqual([
				"legacy-entry",
			]);
			expect(await readFile(sourcePath, "utf8")).toContain("legacy prompt");
			const second = await importLegacySessions({ repository, fs: env, sessionsRoot });
			expect(second).toEqual({ imported: 0, skipped: 1, failed: 0 });
		} finally {
			await repository.close();
			await env.cleanup();
		}
	});
});
