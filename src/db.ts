import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH =
  process.env.CC_MONITOR_DB ?? join(homedir(), ".claude-monitor", "db.sqlite");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA synchronous = NORMAL");

// Refuse to run against a v1 database — its `messages` table is incompatible
// with the v2 `events` schema and silently coexisting would corrupt both.
{
  const v1Marker = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`
    )
    .get();
  const v2Marker = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='events'`
    )
    .get();
  if (v1Marker && !v2Marker) {
    throw new Error(
      `[claude-monitor] Detected a v1 database at ${DB_PATH}. v2 uses a different schema.\n` +
        `Re-ingest from JSONL with:\n  rm ${DB_PATH} ${DB_PATH}-wal ${DB_PATH}-shm\n  bun run ingest`
    );
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path     TEXT NOT NULL,
    byte_offset   INTEGER NOT NULL,
    line_sha      TEXT NOT NULL,
    session_id    TEXT,
    kind          TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    uuid          TEXT,
    parent_uuid   TEXT,
    tool_use_id   TEXT,
    tool_result_id TEXT,
    is_sidechain  INTEGER NOT NULL DEFAULT 0,
    stop_reason   TEXT,
    text_preview  TEXT,
    raw           TEXT NOT NULL,
    usage_in           INTEGER,
    usage_out          INTEGER,
    usage_cache_read   INTEGER,
    usage_cache_create INTEGER,
    UNIQUE(file_path, byte_offset)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_ts  ON events(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_events_tool_use_id ON events(tool_use_id);
  CREATE INDEX IF NOT EXISTS idx_events_tool_result ON events(tool_result_id);
  CREATE INDEX IF NOT EXISTS idx_events_uuid        ON events(uuid);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_line_sha ON events(line_sha);

  CREATE TABLE IF NOT EXISTS tool_invocations (
    tool_use_id  TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    name         TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER,
    is_error     INTEGER,
    is_sidechain INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_tool_open
    ON tool_invocations(session_id) WHERE completed_at IS NULL;

  CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    project_path        TEXT NOT NULL,
    project_name        TEXT NOT NULL,
    title               TEXT,
    file_path           TEXT NOT NULL,
    started_at          INTEGER NOT NULL,
    last_event_ts       INTEGER NOT NULL,
    -- Latest ts of a *real* event (user/assistant/exit). Doesn't move on
    -- noise envelopes (permission_mode, ai_title, system_meta, hook_*).
    -- This is what the UI sorts and buckets on so dormant sessions don't
    -- float to the top whenever Claude Code re-emits metadata.
    last_real_event_ts  INTEGER NOT NULL DEFAULT 0,
    state               TEXT NOT NULL,
    sub_state           TEXT,
    state_since         INTEGER NOT NULL,
    current_tool_use_id TEXT,
    exited_at_event     INTEGER,
    hook_perm_prompt_at INTEGER,
    current_permission_mode TEXT,
    tokens_in           INTEGER NOT NULL DEFAULT 0,
    tokens_out          INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
    tokens_cache_create INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_state    ON sessions(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_event_ts DESC);

  CREATE TABLE IF NOT EXISTS file_offsets (
    file_path   TEXT PRIMARY KEY,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    inode       INTEGER,
    last_size   INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    text_preview,
    content='events',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, text_preview) VALUES (new.id, new.text_preview);
  END;
  CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text_preview) VALUES ('delete', old.id, old.text_preview);
  END;
  CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text_preview) VALUES ('delete', old.id, old.text_preview);
    INSERT INTO events_fts(rowid, text_preview) VALUES (new.id, new.text_preview);
  END;

  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

// Post-create ALTER TABLE migrations. SQLite has no IF NOT EXISTS for ADD COLUMN,
// so swallow the duplicate-column error per attempt.
function tryExec(sql: string) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!String(err).includes("duplicate column")) throw err;
  }
}
tryExec(`ALTER TABLE events ADD COLUMN usage_in INTEGER`);
tryExec(`ALTER TABLE events ADD COLUMN usage_out INTEGER`);
tryExec(`ALTER TABLE events ADD COLUMN usage_cache_read INTEGER`);
tryExec(`ALTER TABLE events ADD COLUMN usage_cache_create INTEGER`);
tryExec(`ALTER TABLE sessions ADD COLUMN current_permission_mode TEXT`);
tryExec(`ALTER TABLE sessions ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0`);
tryExec(`ALTER TABLE sessions ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0`);
tryExec(`ALTER TABLE sessions ADD COLUMN tokens_cache_read INTEGER NOT NULL DEFAULT 0`);
tryExec(`ALTER TABLE sessions ADD COLUMN tokens_cache_create INTEGER NOT NULL DEFAULT 0`);
tryExec(`ALTER TABLE sessions ADD COLUMN last_real_event_ts INTEGER NOT NULL DEFAULT 0`);

export type EventKind =
  | "user_text"
  | "user_tool_result"
  | "assistant_text"
  | "assistant_thinking"
  | "assistant_tool_use"
  | "exit"
  /**
   * Claude Code's auto-injected user envelopes (`<local-command-stdout>`,
   * `<local-command-caveat>`, the slash-command goodbye message). They share
   * the same JSONL shape as user_text but aren't user activity — projection
   * must not treat them as "the user is back" or "a real event landed after
   * /exit." Stored so the transcript view can render them; excluded from the
   * "real event" set in state/project.ts.
   */
  | "system_meta"
  | "permission_mode"
  | "ai_title"
  | "hook_notification"
  | "hook_stop"
  | "hook_subagent_stop";

export type SessionState = "WORKING" | "AWAITING_USER" | "EXITED";
export type SessionSubState =
  | "tool_in_flight"
  | "streaming"
  | "subagent_running"
  | "permission_prompt"
  | "plan_approval"
  | "question"
  | "turn_complete"
  | null;

export interface EventRow {
  id: number;
  file_path: string;
  byte_offset: number;
  line_sha: string;
  session_id: string | null;
  kind: EventKind;
  ts: number;
  uuid: string | null;
  parent_uuid: string | null;
  tool_use_id: string | null;
  tool_result_id: string | null;
  is_sidechain: number;
  stop_reason: string | null;
  text_preview: string | null;
  raw: string;
  usage_in: number | null;
  usage_out: number | null;
  usage_cache_read: number | null;
  usage_cache_create: number | null;
}

export interface SessionRow {
  id: string;
  project_path: string;
  project_name: string;
  title: string | null;
  file_path: string;
  started_at: number;
  last_event_ts: number;
  last_real_event_ts: number;
  state: SessionState;
  sub_state: SessionSubState;
  state_since: number;
  current_tool_use_id: string | null;
  exited_at_event: number | null;
  hook_perm_prompt_at: number | null;
  current_permission_mode: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
}

export interface ToolInvocationRow {
  tool_use_id: string;
  session_id: string;
  name: string;
  started_at: number;
  completed_at: number | null;
  is_error: number | null;
  is_sidechain: number;
}

export const stmts = {
  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO events (
      file_path, byte_offset, line_sha, session_id, kind, ts,
      uuid, parent_uuid, tool_use_id, tool_result_id, is_sidechain, stop_reason,
      text_preview, raw,
      usage_in, usage_out, usage_cache_read, usage_cache_create
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `),

  bumpSessionTokens: db.prepare(`
    UPDATE sessions
       SET tokens_in           = tokens_in           + ?,
           tokens_out          = tokens_out          + ?,
           tokens_cache_read   = tokens_cache_read   + ?,
           tokens_cache_create = tokens_cache_create + ?
     WHERE id = ?
  `),

  setCurrentPermissionMode: db.prepare(`
    UPDATE sessions SET current_permission_mode = ? WHERE id = ?
  `),

  setMeta: db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`),
  getMeta: db.prepare(`SELECT v FROM meta WHERE k = ?`),

  upsertSessionStub: db.prepare(`
    INSERT INTO sessions (
      id, project_path, project_name, file_path,
      started_at, last_event_ts, state, sub_state, state_since
    )
    VALUES (?, ?, ?, ?, ?, ?, 'WORKING', 'streaming', ?)
    ON CONFLICT(id) DO UPDATE SET
      last_event_ts = MAX(sessions.last_event_ts, excluded.last_event_ts),
      started_at    = MIN(sessions.started_at,    excluded.started_at),
      file_path     = excluded.file_path
  `),

  setSessionTitle: db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`),

  setSessionState: db.prepare(`
    UPDATE sessions
       SET state = ?, sub_state = ?, state_since = ?,
           current_tool_use_id = ?, exited_at_event = ?
     WHERE id = ?
  `),

  setHookPermPromptAt: db.prepare(`
    UPDATE sessions SET hook_perm_prompt_at = ? WHERE id = ?
  `),

  bumpLastEventTs: db.prepare(`
    UPDATE sessions SET last_event_ts = MAX(last_event_ts, ?) WHERE id = ?
  `),

  bumpLastRealEventTs: db.prepare(`
    UPDATE sessions SET last_real_event_ts = MAX(last_real_event_ts, ?) WHERE id = ?
  `),

  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),

  listSessions: db.prepare(`
    SELECT * FROM sessions
    ORDER BY MAX(last_real_event_ts, started_at) DESC
    LIMIT ? OFFSET ?
  `),

  getOffset: db.prepare(`SELECT * FROM file_offsets WHERE file_path = ?`),

  setOffset: db.prepare(`
    INSERT INTO file_offsets (file_path, byte_offset, inode, last_size, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      inode       = excluded.inode,
      last_size   = excluded.last_size,
      updated_at  = excluded.updated_at
  `),

  resetOffset: db.prepare(`DELETE FROM file_offsets WHERE file_path = ?`),

  // Tool invocations.
  //
  // Claude Code's JSONL is not always written in tool_use → tool_result order
  // (we've observed the result line written before the use line for the same
  // tool_use_id, by a few KB of file offset). Both INSERT/UPSERT statements
  // are designed to converge to the same row regardless of arrival order:
  //
  //   tool_use first  : upsertToolStart creates a row with completed_at=NULL.
  //                     Later, completeToolUpsert hits the conflict path and
  //                     fills in completed_at without disturbing name/started_at.
  //
  //   tool_result first: completeToolUpsert inserts a placeholder row with
  //                     name='?', started_at=ts, completed_at=ts. Later,
  //                     upsertToolStart hits the conflict path and fills in
  //                     the real name/session_id/is_sidechain and lowers
  //                     started_at via MIN(). It deliberately does NOT touch
  //                     completed_at, so the close stamp is preserved.
  upsertToolStart: db.prepare(`
    INSERT INTO tool_invocations (tool_use_id, session_id, name, started_at, is_sidechain)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tool_use_id) DO UPDATE SET
      session_id   = excluded.session_id,
      name         = excluded.name,
      started_at   = MIN(tool_invocations.started_at, excluded.started_at),
      is_sidechain = excluded.is_sidechain
  `),

  completeToolUpsert: db.prepare(`
    INSERT INTO tool_invocations (tool_use_id, session_id, name, started_at, completed_at, is_error, is_sidechain)
    VALUES (?, ?, '?', ?, ?, ?, 0)
    ON CONFLICT(tool_use_id) DO UPDATE SET
      completed_at = excluded.completed_at,
      is_error     = excluded.is_error
  `),

  getOpenTools: db.prepare(`
    SELECT * FROM tool_invocations
     WHERE session_id = ? AND completed_at IS NULL
     ORDER BY started_at ASC
  `),

  getToolByUseId: db.prepare(`SELECT * FROM tool_invocations WHERE tool_use_id = ?`),

  // Latest events per session (for projection)
  getLatestEvent: db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
     ORDER BY ts DESC, id DESC
     LIMIT 1
  `),

  getLatestEventOfKinds: db.prepare(`
    SELECT * FROM events
     WHERE session_id = ? AND kind IN (SELECT value FROM json_each(?))
     ORDER BY ts DESC, id DESC
     LIMIT 1
  `),

  getLatestNonSidechainAssistant: db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND kind IN ('assistant_text','assistant_thinking','assistant_tool_use')
       AND is_sidechain = 0
     ORDER BY ts DESC, id DESC
     LIMIT 1
  `),

  // Latest "real" user-driven event (user_text / user_tool_result / exit).
  // Used by the projection to decide whether a permission_prompt hook has been
  // cleared, independently of whatever assistant/meta event happens to be
  // newest. See state/project.ts Rule 3.
  getLatestRealUserEvent: db.prepare(`
    SELECT * FROM events
     WHERE session_id = ?
       AND kind IN ('user_text','user_tool_result','exit')
     ORDER BY ts DESC, id DESC
     LIMIT 1
  `),

  getEventsForSession: db.prepare(`
    SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC, id ASC
  `),

  countEventsForSession: db.prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ?`),

  // Search
  searchEvents: db.prepare(`
    SELECT
      e.id, e.session_id, e.kind, e.ts,
      snippet(events_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
      s.project_name, s.project_path
    FROM events_fts
    JOIN events e ON e.id = events_fts.rowid
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE events_fts MATCH ?
    ORDER BY e.ts DESC
    LIMIT ?
  `),
};

export const DB_FILE = DB_PATH;
