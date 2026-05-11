/**
 * Auto-archive sessions that have gone quiet. The dashboard becomes unusable
 * once you've accumulated months of finished work; archived rows are still
 * fully searchable and reachable by direct URL, just filtered out of the
 * default session list.
 *
 * Threshold is configurable via CC_ARCHIVE_AFTER_DAYS (default 14). Set to 0
 * to disable auto-archiving entirely.
 */
import { stmts } from "./db.ts";

export const ARCHIVE_AFTER_MS =
  (Number(process.env.CC_ARCHIVE_AFTER_DAYS ?? 14) || 0) * 24 * 60 * 60 * 1000;

/**
 * Stamp archived_at on every session whose last real event predates the
 * cutoff. Idempotent — re-running with no new candidates is a no-op.
 * Returns the number of sessions newly archived this pass.
 */
export function archiveStaleSessions(now: number = Date.now()): number {
  if (ARCHIVE_AFTER_MS <= 0) return 0;
  const cutoff = now - ARCHIVE_AFTER_MS;
  const res = stmts.archiveStaleSessions.run(now, cutoff);
  return Number(res.changes ?? 0);
}
