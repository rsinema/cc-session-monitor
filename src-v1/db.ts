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

// One-shot migrations. SQLite has no IF NOT EXISTS for ALTER, so swallow the duplicate-column error.
function tryExec(sql: string) {
  try {
    db.exec(sql);
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("duplicate column")) throw err;
  }
}

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

// Post-CREATE migrations.
tryExec(`ALTER TABLE sessions ADD COLUMN awaiting_tool_id TEXT`);
tryExec(`ALTER TABLE sessions ADD COLUMN exited_at INTEGER`);
tryExec(`ALTER TABLE sessions ADD COLUMN title TEXT`);

// Generic key/value store for one-shot migration markers.
db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);

// One-shot migration: previous ingest code saved file_offsets.last_line as
// `lines.length` (split count, including the trailing empty entry when the
// file ended in \n). That was off-by-one — a later append would start past
// the new real content. Decrementing every existing offset by 1 puts it at
// the correct re-entry point (the trailing empty index, idempotent re-read).
const migrationKey = "file_offsets_decrement_v1";
const migrationDone = db
  .query(`SELECT 1 FROM meta WHERE k = ?`)
  .get(migrationKey);
if (!migrationDone) {
  const result = db.exec(
    `UPDATE file_offsets SET last_line = MAX(0, last_line - 1)`
  );
  db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, '1')`).run(migrationKey);
  console.log(`[migration] ${migrationKey}: decremented file_offsets`);
}

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
      last_activity = MAX(sessions.last_activity, excluded.last_activity),
      started_at = MIN(sessions.started_at, excluded.started_at),
      file_path = excluded.file_path
    -- project_path / project_name are NOT updated on conflict so a subagent
    -- file (whose cwd is a worktree) can't overwrite the main session's path.
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
  clearAwaitingInputForSession: db.prepare(
    `UPDATE sessions SET awaiting_input = 0, awaiting_tool_id = NULL WHERE id = ?`
  ),

  /** Set awaiting state because a blocking tool_use (AskUserQuestion / ExitPlanMode) was just ingested. */
  setAwaitingByToolUse: db.prepare(
    `UPDATE sessions SET awaiting_input = 1, awaiting_tool_id = ? WHERE id = ?`
  ),

  /**
   * Clear awaiting state on incoming tool_result. Matches whether the recorded
   * tool id matches the tool_use_id (precise case) OR awaiting was set by a
   * Notification hook with NULL tool id (covers permission prompts where no
   * Stop hook follows).
   */
  clearAwaitingByToolResult: db.prepare(
    `UPDATE sessions SET awaiting_input = 0, awaiting_tool_id = NULL
     WHERE id = ? AND (awaiting_tool_id = ? OR awaiting_tool_id IS NULL)`
  ),

  /**
   * Set exited_at when a `/exit` command is observed. Detection happens at the
   * `<command-name>/exit</command-name>` tag — invariant across Claude Code's
   * rotating goodbye stdout text (Goodbye!/See ya!/Bye!/etc).
   */
  markExited: db.prepare(`UPDATE sessions SET exited_at = ? WHERE id = ?`),

  /**
   * Clear exited_at when a strictly-later real message arrives (resume signal).
   * Uses `<` so the goodbye-stdout / caveat lines that share the /exit's
   * timestamp don't accidentally clear it.
   */
  clearExitedIfBefore: db.prepare(
    `UPDATE sessions SET exited_at = NULL WHERE id = ? AND exited_at IS NOT NULL AND exited_at < ?`
  ),

  /** Set the AI-generated chat title (last write wins; titles can be regenerated). */
  setTitle: db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`),

  getSessionById: db.prepare(`SELECT * FROM sessions WHERE id = ?`),

  listSessions: db.prepare(`
    SELECT
      s.*,
      latest.role         AS latest_role,
      latest.type         AS latest_type,
      latest.text_preview AS latest_preview,
      latest.timestamp    AS latest_ts
    FROM sessions s
    LEFT JOIN (
      -- ROW_NUMBER with line_number tiebreaker so sessions with multiple
      -- messages sharing the same timestamp (e.g. /exit which writes the
      -- command, caveat, and stdout in one batch) yield exactly one row.
      SELECT session_id, role, type, text_preview, timestamp
      FROM (
        SELECT
          session_id, role, type, text_preview, timestamp,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY timestamp DESC, line_number DESC
          ) AS rn
        FROM messages
      )
      WHERE rn = 1
    ) latest ON latest.session_id = s.id
    ORDER BY s.last_activity DESC
    LIMIT ? OFFSET ?
  `),

  getMessagesBySession: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, line_number ASC
  `),

  /** Most recent N messages for a session, returned in chronological order. */
  getLatestMessages: db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC, line_number DESC
      LIMIT ?
    ) ORDER BY timestamp ASC, line_number ASC
  `),

  /** Messages strictly before a given timestamp, most-recent first; flip in JS. */
  getMessagesBefore: db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE session_id = ? AND timestamp < ?
      ORDER BY timestamp DESC, line_number DESC
      LIMIT ?
    ) ORDER BY timestamp ASC, line_number ASC
  `),

  countMessagesInSession: db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ?`),

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
