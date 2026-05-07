import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = join(homedir(), ".claude-monitor", "db.sqlite");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    project_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL,
    awaiting_input INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id TEXT,
    role TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    text_preview TEXT,
    timestamp INTEGER NOT NULL,
    line_number INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

  CREATE TABLE IF NOT EXISTS file_offsets (
    file_path TEXT PRIMARY KEY,
    last_line INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text_preview,
    content='messages',
    content_rowid='rowid'
  );
`);

// FTS sync triggers (idempotent — safe to re-run).
db.exec(`
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text_preview) VALUES (new.rowid, new.text_preview);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text_preview) VALUES ('delete', old.rowid, old.text_preview);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text_preview) VALUES ('delete', old.rowid, old.text_preview);
    INSERT INTO messages_fts(rowid, text_preview) VALUES (new.rowid, new.text_preview);
  END;
`);

export const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, project_path, project_name, started_at, last_activity, message_count, file_path, awaiting_input)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      project_path = excluded.project_path,
      project_name = excluded.project_name,
      last_activity = MAX(sessions.last_activity, excluded.last_activity),
      started_at = MIN(sessions.started_at, excluded.started_at),
      file_path = excluded.file_path
  `),

  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, parent_id, role, type, content, text_preview, timestamp, line_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  bumpSessionAfterMessage: db.prepare(`
    UPDATE sessions
    SET last_activity = MAX(last_activity, ?),
        started_at = MIN(started_at, ?),
        message_count = (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id)
    WHERE id = ?
  `),

  setAwaitingInput: db.prepare(`UPDATE sessions SET awaiting_input = ? WHERE id = ?`),
  clearAwaitingInputForSession: db.prepare(`UPDATE sessions SET awaiting_input = 0 WHERE id = ?`),

  getSessionById: db.prepare(`SELECT * FROM sessions WHERE id = ?`),

  listSessions: db.prepare(`
    SELECT * FROM sessions
    ORDER BY last_activity DESC
    LIMIT ? OFFSET ?
  `),

  getMessagesBySession: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, line_number ASC
  `),

  searchMessages: db.prepare(`
    SELECT
      m.id        AS id,
      m.session_id AS session_id,
      m.role      AS role,
      m.type      AS type,
      m.timestamp AS timestamp,
      snippet(messages_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
      s.project_name AS project_name,
      s.project_path AS project_path
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `),

  getOffset: db.prepare(`SELECT last_line FROM file_offsets WHERE file_path = ?`),
  setOffset: db.prepare(`
    INSERT INTO file_offsets (file_path, last_line) VALUES (?, ?)
    ON CONFLICT(file_path) DO UPDATE SET last_line = excluded.last_line
  `),

  resetOffset: db.prepare(`DELETE FROM file_offsets WHERE file_path = ?`),
};
