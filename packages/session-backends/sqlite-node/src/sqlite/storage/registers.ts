import type { RegisterWrite, SessionRegister } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

interface RegisterRow {
	session_id: string;
	namespace: string;
	key: string;
	seq: number;
	value: string;
}

export function readRegister(
	db: SqliteDatabase,
	sessionId: string,
	namespace: string,
	key: string,
): SessionRegister | undefined {
	const row = sql`SELECT session_id, namespace, key, seq, value
		FROM registers WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`.get<RegisterRow>(
		db,
	);
	if (!row) return undefined;
	return { namespace: row.namespace, key: row.key, seq: row.seq, value: JSON.parse(row.value) };
}

export function writeRegister(db: SqliteDatabase, sessionId: string, seq: number, write: RegisterWrite): void {
	if (write.op === "delete") {
		sql`DELETE FROM registers WHERE session_id = ${sessionId} AND namespace = ${write.namespace} AND key = ${write.key}`.run(
			db,
		);
		return;
	}
	sql`INSERT INTO registers (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${write.namespace}, ${write.key}, ${seq}, ${JSON.stringify(write.value)})
		ON CONFLICT(session_id, namespace, key) DO UPDATE SET seq = excluded.seq, value = excluded.value`.run(db);
}

export function deleteRegisterRows(db: SqliteDatabase, sessionId: string): void {
	sql`DELETE FROM registers WHERE session_id = ${sessionId}`.run(db);
}
