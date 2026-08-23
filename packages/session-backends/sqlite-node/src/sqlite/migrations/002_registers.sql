CREATE TABLE IF NOT EXISTS registers (
	session_id TEXT NOT NULL,
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (session_id, namespace, key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_registers_session_seq ON registers(session_id, seq);
