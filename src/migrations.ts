/**
 * One-shot migrations for v2 schema additions. Each is gated behind a meta
 * key so startup is idempotent. Called from server.ts boot and from the
 * ingest CLI.
 */
import { db, stmts } from "./db.ts";

interface MigrationResult {
  /** Migration key. */
  key: string;
  /** True if this run actually performed work. False = already done. */
  ran: boolean;
  /** Cheap descriptor of what changed. */
  details?: string;
}

export function runMigrations(): MigrationResult[] {
  return [
    backfillUsageColumns(),
    backfillCurrentPermissionMode(),
    backfillLastRealEventTs(),
    fixStuckToolInvocations(),
    healStaleHookPermPromptAt(),
  ];
}

function isDone(key: string): boolean {
  const row = stmts.getMeta.get(key) as { v: string } | undefined;
  return row?.v === "1";
}
function markDone(key: string) {
  stmts.setMeta.run(key, "1");
}

/**
 * Re-parse `raw` for every assistant event whose usage_in IS NULL, populate
 * the four usage_* columns, and add their values into sessions.tokens_*.
 * Re-runnable safely until the meta key is set: once flipped, the migration
 * is a no-op.
 */
function backfillUsageColumns(): MigrationResult {
  const KEY = "usage_backfill_v1";
  if (isDone(KEY)) return { key: KEY, ran: false };

  // Reset session totals before re-aggregating, so a partial previous run
  // doesn't double-count.
  db.exec(`
    UPDATE sessions
       SET tokens_in = 0, tokens_out = 0,
           tokens_cache_read = 0, tokens_cache_create = 0
  `);

  const update = db.prepare(`
    UPDATE events
       SET usage_in = ?, usage_out = ?, usage_cache_read = ?, usage_cache_create = ?
     WHERE id = ?
  `);

  const rows = db
    .query(
      `SELECT id, session_id, raw FROM events
        WHERE kind IN ('assistant_text','assistant_thinking','assistant_tool_use')`
    )
    .all() as { id: number; session_id: string | null; raw: string }[];

  let touched = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      let parsed: any;
      try {
        parsed = JSON.parse(r.raw);
      } catch {
        skipped++;
        continue;
      }
      const u = parsed?.message?.usage;
      if (!u || typeof u !== "object") continue;
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      const inT = num(u.input_tokens);
      const outT = num(u.output_tokens);
      const crT = num(u.cache_read_input_tokens);
      const ccT = num(u.cache_creation_input_tokens);
      if (inT == null && outT == null && crT == null && ccT == null) continue;

      update.run(inT, outT, crT, ccT, r.id);
      if (r.session_id) {
        stmts.bumpSessionTokens.run(inT ?? 0, outT ?? 0, crT ?? 0, ccT ?? 0, r.session_id);
      }
      touched++;
    }
    markDone(KEY);
  });
  tx();
  return {
    key: KEY,
    ran: true,
    details: `populated usage on ${touched} assistant events (${skipped} unparseable)`,
  };
}

/**
 * Close tool_invocations that were left open because the matching tool_result
 * event was ingested before its tool_use (Claude Code's JSONL is occasionally
 * out of order). For each open row, look for a user_tool_result event in the
 * same session whose tool_result_id matches; if found, stamp completed_at
 * with that event's ts. Cheap (indexed on tool_result_id).
 *
 * Re-runnable each boot — the WHERE completed_at IS NULL guard keeps it
 * idempotent without a meta key, and we want it to run after every restart
 * to catch any new stuck rows from the same out-of-order pattern.
 */
function fixStuckToolInvocations(): MigrationResult {
  const KEY = "fix_stuck_tool_invocations";
  const before = db
    .query(
      `SELECT COUNT(*) AS c FROM tool_invocations WHERE completed_at IS NULL`
    )
    .get() as { c: number };

  db.exec(`
    UPDATE tool_invocations
       SET completed_at = (
         SELECT MAX(e.ts) FROM events e
          WHERE e.session_id = tool_invocations.session_id
            AND e.tool_result_id = tool_invocations.tool_use_id
       )
     WHERE completed_at IS NULL
       AND EXISTS (
         SELECT 1 FROM events e
          WHERE e.session_id = tool_invocations.session_id
            AND e.tool_result_id = tool_invocations.tool_use_id
       )
  `);

  const after = db
    .query(
      `SELECT COUNT(*) AS c FROM tool_invocations WHERE completed_at IS NULL`
    )
    .get() as { c: number };
  const closed = before.c - after.c;
  return {
    key: KEY,
    ran: closed > 0,
    details: closed > 0 ? `closed ${closed} stuck tool_invocations` : undefined,
  };
}

/**
 * For each session, set last_real_event_ts = max(ts) of its real events
 * (user/assistant/exit). Existing rows had this field defaulting to 0 from
 * the ALTER TABLE, which would make the dashboard sort dump them to the end.
 * One-shot scan: cheap (single GROUP BY).
 */
function backfillLastRealEventTs(): MigrationResult {
  const KEY = "last_real_event_ts_backfill_v1";
  if (isDone(KEY)) return { key: KEY, ran: false };

  const tx = db.transaction(() => {
    db.exec(`
      UPDATE sessions
         SET last_real_event_ts = COALESCE((
           SELECT MAX(ts) FROM events
            WHERE events.session_id = sessions.id
              AND kind IN (
                'user_text','user_tool_result',
                'assistant_text','assistant_thinking','assistant_tool_use',
                'exit'
              )
         ), 0)
    `);
    markDone(KEY);
  });
  tx();

  const populated = db
    .query(`SELECT COUNT(*) AS c FROM sessions WHERE last_real_event_ts > 0`)
    .get() as { c: number };
  return {
    key: KEY,
    ran: true,
    details: `populated last_real_event_ts on ${populated.c} sessions`,
  };
}

/**
 * Heal sessions stuck on `permission_prompt` because the prior version of
 * the hook handler treated *every* Notification (including 60s idle pings
 * and generic "Claude needs your attention" pings) as a permission ask,
 * which moved hook_perm_prompt_at past the user's most recent reply and
 * pinned the projection to permission_prompt.
 *
 * For each session whose hook_perm_prompt_at points at a Notification event
 * that was NOT actually a permission ask, clear the flag. recomputeAllStates
 * runs immediately after migrations on boot and re-projects every session,
 * so the UI heals without a second restart.
 *
 * Re-runnable each boot (idempotent — once cleared, sessions stay clear
 * unless a new bad notification lands, which the patched hook handler
 * won't write).
 */
function healStaleHookPermPromptAt(): MigrationResult {
  const KEY = "heal_stale_hook_perm_prompt_at";

  const before = db
    .query(
      `SELECT COUNT(*) AS c FROM sessions WHERE hook_perm_prompt_at IS NOT NULL`
    )
    .get() as { c: number };

  // Clear hook_perm_prompt_at on sessions where the Notification event that
  // matches that timestamp is NOT a permission ask (or no such event exists).
  // text_preview is populated from body.message at ingest time (hooks.ts).
  db.exec(`
    UPDATE sessions
       SET hook_perm_prompt_at = NULL
     WHERE hook_perm_prompt_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM events e
          WHERE e.session_id = sessions.id
            AND e.kind = 'hook_notification'
            AND e.ts = sessions.hook_perm_prompt_at
            AND e.text_preview LIKE '%needs your permission%'
       )
  `);

  const after = db
    .query(
      `SELECT COUNT(*) AS c FROM sessions WHERE hook_perm_prompt_at IS NOT NULL`
    )
    .get() as { c: number };

  const cleared = before.c - after.c;
  return {
    key: KEY,
    ran: cleared > 0,
    details: cleared > 0 ? `cleared stale hook_perm_prompt_at on ${cleared} sessions` : undefined,
  };
}

/**
 * For each session, find the most recent permission_mode event (latest by id —
 * ts on these envelopes is unreliable) and write its mode into
 * sessions.current_permission_mode.
 */
function backfillCurrentPermissionMode(): MigrationResult {
  const KEY = "permission_mode_backfill_v1";
  if (isDone(KEY)) return { key: KEY, ran: false };

  const rows = db
    .query(
      `SELECT e.session_id, e.text_preview AS mode
         FROM events e
         JOIN (
           SELECT session_id, MAX(id) AS max_id
             FROM events
            WHERE kind = 'permission_mode' AND session_id IS NOT NULL
         GROUP BY session_id
         ) latest
           ON latest.session_id = e.session_id AND latest.max_id = e.id`
    )
    .all() as { session_id: string; mode: string | null }[];

  let touched = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.mode) continue;
      stmts.setCurrentPermissionMode.run(r.mode, r.session_id);
      touched++;
    }
    markDone(KEY);
  });
  tx();
  return {
    key: KEY,
    ran: true,
    details: `set current_permission_mode on ${touched} sessions`,
  };
}
