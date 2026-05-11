import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "ccmon-archiver-"));
process.env.CC_MONITOR_DB = join(tmp, "db.sqlite");

const { db, stmts } = await import("./db.ts");
const { archiveStaleSessions } = await import("./archiver.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

function insertSession(id: string, lastRealEventTs: number) {
  // Stub a row with state defaulted; archiver only cares about
  // last_real_event_ts and archived_at.
  stmts.upsertSessionStub.run(id, "/p", "p", "/tmp/x.jsonl", lastRealEventTs, lastRealEventTs, lastRealEventTs);
  db.query(`UPDATE sessions SET last_real_event_ts = ? WHERE id = ?`).run(lastRealEventTs, id);
}

beforeEach(() => {
  db.exec(`
    DELETE FROM events;
    DELETE FROM tool_invocations;
    DELETE FROM sessions;
    DELETE FROM file_offsets;
  `);
});

describe("archiveStaleSessions", () => {
  test("archives sessions older than 14 days, leaves fresh ones alone", () => {
    const now = Date.now();
    insertSession("fresh", now - 3 * DAY_MS);
    insertSession("stale", now - 30 * DAY_MS);

    const archived = archiveStaleSessions(now);
    expect(archived).toBe(1);

    const fresh = stmts.getSession.get("fresh") as any;
    const stale = stmts.getSession.get("stale") as any;
    expect(fresh.archived_at).toBeNull();
    expect(stale.archived_at).toBe(now);
  });

  test("is idempotent — re-running doesn't bump archived_at on already-archived rows", () => {
    const now = Date.now();
    insertSession("stale", now - 30 * DAY_MS);

    archiveStaleSessions(now);
    const firstStamp = (stmts.getSession.get("stale") as any).archived_at;

    archiveStaleSessions(now + 1000);
    const secondStamp = (stmts.getSession.get("stale") as any).archived_at;

    expect(secondStamp).toBe(firstStamp);
  });

  test("skips sessions with last_real_event_ts = 0 (never had a real event)", () => {
    // Sessions that only ever saw meta envelopes shouldn't get archived —
    // we'd lose them forever despite never having seen activity to gauge by.
    insertSession("metaonly", 0);
    const archived = archiveStaleSessions(Date.now());
    expect(archived).toBe(0);
    const row = stmts.getSession.get("metaonly") as any;
    expect(row.archived_at).toBeNull();
  });

  test("bumpLastRealEventTs auto-unarchives a session", () => {
    const now = Date.now();
    insertSession("stale", now - 30 * DAY_MS);
    archiveStaleSessions(now);
    expect((stmts.getSession.get("stale") as any).archived_at).not.toBeNull();

    // New real event lands.
    stmts.bumpLastRealEventTs.run(now, "stale");
    expect((stmts.getSession.get("stale") as any).archived_at).toBeNull();
  });
});
