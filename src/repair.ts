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
 * Clear `awaiting_input` for any session whose most-recent message is already
 * from the user (text or tool_result). This handles the case where a
 * Notification hook fired (e.g. AskUserQuestion, permission prompt) but no
 * Stop hook followed, leaving the flag stuck on after the user answered.
 *
 * Returns the set of session ids that were cleared.
 */
export function clearStaleAwaiting(): Set<string> {
  const cleared = new Set<string>();
  const rows = db
    .query(
      `SELECT s.id,
              (SELECT m.role FROM messages m
                WHERE m.session_id = s.id
                ORDER BY m.timestamp DESC, m.line_number DESC LIMIT 1) AS last_role
       FROM sessions s
       WHERE s.awaiting_input = 1`
    )
    .all() as { id: string; last_role: string | null }[];

  for (const row of rows) {
    if (row.last_role === "user") {
      stmts.clearAwaitingInputForSession.run(row.id);
      cleared.add(row.id);
    }
  }
  return cleared;
}
