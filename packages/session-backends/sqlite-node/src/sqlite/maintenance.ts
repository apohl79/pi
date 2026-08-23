import type { SqliteDatabase } from "./types.ts";

export interface SqliteInspection {
	/** IDs of migrations applied to the database, in application order. */
	appliedMigrations: string[];
	/** Latest applied migration ID, or null for an uninitialized database. */
	schemaVersion: string | null;
	/** Results returned by SQLite's quick integrity check. */
	quickCheck: string[];
	/** Rows reported by SQLite's foreign-key integrity check. */
	foreignKeyErrors: readonly SqliteForeignKeyError[];
	/** True only when every quick-check result is exactly "ok". */
	healthy: boolean;
}

export interface SqliteForeignKeyError {
	table: string;
	rowid: number;
	parent: string;
	fkid: number;
}

interface MigrationRow {
	id: string;
}

interface QuickCheckRow {
	quick_check: string;
}

interface ForeignKeyRow {
	table: string;
	rowid: number;
	parent: string;
	fkid: number;
}

/** Inspects canonical SQLite state without changing records or derived indexes. */
export function inspectSqliteDatabase(db: SqliteDatabase): SqliteInspection {
	const appliedMigrations = db
		.prepare("SELECT id FROM migrations ORDER BY applied_at, id")
		.all<MigrationRow>()
		.map((row) => row.id);
	const quickCheck = db
		.prepare("PRAGMA quick_check")
		.all<QuickCheckRow>()
		.map((row) => row.quick_check);
	const foreignKeyErrors = db
		.prepare("PRAGMA foreign_key_check")
		.all<ForeignKeyRow>()
		.map((row) => ({ table: row.table, rowid: row.rowid, parent: row.parent, fkid: row.fkid }));
	return {
		appliedMigrations,
		schemaVersion: appliedMigrations.at(-1) ?? null,
		quickCheck,
		foreignKeyErrors,
		healthy: quickCheck.length > 0 && quickCheck.every((result) => result === "ok") && foreignKeyErrors.length === 0,
	};
}

/** Quotes a filesystem path as a SQLite string literal for VACUUM INTO. */
export function sqliteStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
