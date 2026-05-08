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
