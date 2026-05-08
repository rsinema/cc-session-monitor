import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, stmts } from "./db.ts";

const BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Scan all assistant tool_use messages for blocking tools (AskUserQuestion,
 * ExitPlanMode). For any whose matching tool_result hasn't been ingested yet,
 * mark the session as awaiting. Idempotent — only sets, never clears, so a
 * legitimately awaiting session set by a Notification hook is preserved.
 *
 * Returns the set of session ids that flipped to awaiting because of this pass.
 */
export function rebuildAwaitingFromMessages(): Set<string> {
  const flipped = new Set<string>();

  // Pull all assistant tool_use rows. For ~14k total messages, this is well under 100ms.
  const rows = db
    .query(
      `SELECT session_id, content, timestamp FROM messages WHERE role = 'assistant' AND type = 'tool_use'`
    )
    .all() as { session_id: string; content: string; timestamp: number }[];

  const checkResult = db.prepare(
    `SELECT 1 FROM messages
     WHERE session_id = ? AND role = 'user' AND type = 'tool_result'
       AND timestamp >= ?
       AND content LIKE ?
     LIMIT 1`
  );

  for (const row of rows) {
    let blocks: any;
    try {
      blocks = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    const blocking = blocks.find(
      (b: any) => b?.type === "tool_use" && BLOCKING_TOOLS.has(b.name) && typeof b.id === "string"
    );
    if (!blocking) continue;

    const found = checkResult.get(
      row.session_id,
      row.timestamp,
      `%"tool_use_id":"${blocking.id}"%`
    );
    if (!found) {
      const before = stmts.getSessionById.get(row.session_id) as any;
      stmts.setAwaitingByToolUse.run(blocking.id, row.session_id);
      if (!before?.awaiting_input) flipped.add(row.session_id);
    }
  }

  return flipped;
}

/**
 * Backfill `sessions.title` from `ai-title` rows in every JSONL. Live ingest
 * captures titles for new lines, but existing files have offsets past the
 * early ai-title row, so a one-time scan is needed. Cheap (~50ms for ~100
 * files) since we substring-filter before JSON.parse.
 *
 * Returns the set of session ids whose title was set or changed.
 */
export function backfillTitles(): Set<string> {
  const updated = new Set<string>();
  const root = join(homedir(), ".claude", "projects");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!s.isFile() || !full.endsWith(".jsonl")) continue;
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      // Last-write-wins: scan all ai-title rows, keep the most recent one per session.
      const latest = new Map<string, string>();
      for (const line of raw.split("\n")) {
        if (!line.includes('"type":"ai-title"')) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          obj?.type !== "ai-title" ||
          typeof obj.sessionId !== "string" ||
          typeof obj.aiTitle !== "string"
        ) {
          continue;
        }
        const t = obj.aiTitle.trim();
        if (t) latest.set(obj.sessionId, t);
      }
      for (const [sessionId, title] of latest) {
        const before = stmts.getSessionById.get(sessionId) as any;
        if (before && before.title !== title) {
          stmts.setTitle.run(title, sessionId);
          updated.add(sessionId);
        }
      }
    }
  }
  return updated;
}

/**
 * Backfill `sessions.exited_at` for sessions that received a `/exit` command
 * before this column existed (or before exit detection was added to ingest).
 * Idempotent: just sets the timestamp of the most recent /exit user message
 * per session. Cheap — scoped to user-text rows by the predicate.
 *
 * Returns the set of session ids whose `exited_at` was set or updated.
 */
export function backfillExitedAt(): Set<string> {
  const updated = new Set<string>();
  // Find the most-recent /exit per session, but only if no message arrived
  // strictly later (HAVING clause). Sessions that exited and then resumed
  // are excluded — they're not "currently exited."
  const rows = db
    .query(
      `SELECT m.session_id, MAX(m.timestamp) AS exit_ts
       FROM messages m
       WHERE m.role = 'user' AND m.type = 'text'
         AND m.text_preview LIKE '%<command-name>/exit</command-name>%'
       GROUP BY m.session_id
       HAVING MAX(m.timestamp) >= (
         SELECT MAX(timestamp) FROM messages WHERE session_id = m.session_id
       )`
    )
    .all() as { session_id: string; exit_ts: number }[];

  for (const row of rows) {
    const before = stmts.getSessionById.get(row.session_id) as any;
    if (before?.exited_at !== row.exit_ts) {
      stmts.markExited.run(row.exit_ts, row.session_id);
      updated.add(row.session_id);
    }
  }
  return updated;
}

/**
 * Infer "Claude has stopped, user is needed" from the JSONL when neither the
 * Stop hook nor the ingest-time `stop_reason: end_turn` path caught it (e.g.
 * historical sessions ingested before stop_reason support was added).
 *
 * A session needs awaiting=1 when:
 *   - last message is assistant text or thinking (turn over, not a tool call)
 *   - the session hasn't been exited
 *   - last_activity is within `recentWindowMs` (don't retroactively flag old chats)
 *   - the message has been settled for at least `idleMs` (avoid flicker mid-turn)
 *
 * Returns the set of session ids that flipped on.
 */
export function inferAwaitingFromIdle(
  idleMs = 15_000,
  recentWindowMs = 60 * 60 * 1000
): Set<string> {
  const flipped = new Set<string>();
  const now = Date.now();
  const idleCutoff = now - idleMs;
  const recentCutoff = now - recentWindowMs;

  const rows = db
    .query(
      `SELECT s.id,
              (SELECT m.role FROM messages m
                WHERE m.session_id = s.id
                ORDER BY m.timestamp DESC, m.line_number DESC LIMIT 1) AS last_role,
              (SELECT m.type FROM messages m
                WHERE m.session_id = s.id
                ORDER BY m.timestamp DESC, m.line_number DESC LIMIT 1) AS last_type,
              (SELECT m.timestamp FROM messages m
                WHERE m.session_id = s.id
                ORDER BY m.timestamp DESC, m.line_number DESC LIMIT 1) AS last_ts
       FROM sessions s
       WHERE s.awaiting_input = 0
         AND s.exited_at IS NULL
         AND s.last_activity >= ?`
    )
    .all(recentCutoff) as {
    id: string;
    last_role: string | null;
    last_type: string | null;
    last_ts: number | null;
  }[];

  for (const row of rows) {
    if (row.last_role !== "assistant") continue;
    if (row.last_type !== "text" && row.last_type !== "thinking") continue;
    if (row.last_ts == null || row.last_ts > idleCutoff) continue;
    stmts.setAwaitingInput.run(1, row.id);
    flipped.add(row.id);
  }
  return flipped;
}

/**
 * Clear `awaiting_input` for sessions where it shouldn't be set:
 *   - exited:    /exit wins; an exited session is never "awaiting input"
 *   - last role is user: a Notification hook fired (e.g. permission prompt /
 *                AskUserQuestion) but no Stop followed, leaving the flag stuck
 *                on after the user answered
 *   - very old:  re-ingest noise from the migration could have flipped awaiting
 *                on sessions that haven't been touched in days. Anything older
 *                than `recentWindowMs` is conservatively cleared.
 *
 * Returns the set of session ids that were cleared.
 */
export function clearStaleAwaiting(
  recentWindowMs = 24 * 60 * 60 * 1000
): Set<string> {
  const cleared = new Set<string>();
  const recentCutoff = Date.now() - recentWindowMs;
  const rows = db
    .query(
      `SELECT s.id,
              s.exited_at,
              s.last_activity,
              (SELECT m.role FROM messages m
                WHERE m.session_id = s.id
                ORDER BY m.timestamp DESC, m.line_number DESC LIMIT 1) AS last_role
       FROM sessions s
       WHERE s.awaiting_input = 1`
    )
    .all() as {
    id: string;
    exited_at: number | null;
    last_activity: number;
    last_role: string | null;
  }[];

  for (const row of rows) {
    const isExited = row.exited_at != null;
    const isStaleByRole = row.last_role === "user";
    const isStaleByAge = row.last_activity < recentCutoff;
    if (isExited || isStaleByRole || isStaleByAge) {
      stmts.clearAwaitingInputForSession.run(row.id);
      cleared.add(row.id);
    }
  }
  return cleared;
}
