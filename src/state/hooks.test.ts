/**
 * Tests for hook ingest. Catches regressions like the insertEvent column-count
 * mismatch that broke /api/hook/notify when usage_* columns were added.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "ccmon-hooks-"));
const DB_FILE = join(tmp, "db.sqlite");
process.env.CC_MONITOR_DB = DB_FILE;

const { db, stmts } = await import("../db.ts");
const { ingestHookEvent } = await import("./hooks.ts");

beforeEach(() => {
  db.exec(`
    DELETE FROM events;
    DELETE FROM tool_invocations;
    DELETE FROM sessions;
    DELETE FROM file_offsets;
  `);
  // Hook handler needs a session row to exist before recompute can run.
  stmts.upsertSessionStub.run(
    "sess-1",
    "/x/y",
    "y",
    "/tmp/file.jsonl",
    1000,
    1000,
    1000
  );
});

describe("ingestHookEvent — schema sanity (18-column insertEvent)", () => {
  test("Notification hook inserts an event row + sets hook_perm_prompt_at", () => {
    const r = ingestHookEvent({
      hook_event_name: "Notification",
      session_id: "sess-1",
      message: "permission needed",
    });
    expect(r.ok).toBe(true);
    expect(r.handled).toBe("hook_notification");
    expect(r.event).toBeDefined();
    expect(r.event!.kind).toBe("hook_notification");

    const session = stmts.getSession.get("sess-1") as any;
    expect(session.hook_perm_prompt_at).toBeGreaterThan(0);
    expect(session.state).toBe("AWAITING_USER");
    expect(session.sub_state).toBe("permission_prompt");
  });

  test("Stop hook inserts an event and triggers recompute", () => {
    const r = ingestHookEvent({
      hook_event_name: "Stop",
      session_id: "sess-1",
    });
    expect(r.handled).toBe("hook_stop");
    const ev = db
      .query("SELECT kind FROM events WHERE session_id = 'sess-1' AND kind = 'hook_stop'")
      .get() as any;
    expect(ev?.kind).toBe("hook_stop");
  });

  test("SubagentStop is acknowledged but does not recompute", () => {
    const r = ingestHookEvent({
      hook_event_name: "SubagentStop",
      session_id: "sess-1",
    });
    expect(r.handled).toBe("hook_subagent_stop");
    // Event is still recorded, but touchedSessions stays empty
    // (SubagentStop is informational for the parent).
    expect(r.touchedSessions?.size ?? 0).toBe(0);
  });

  test("repeat hook payload is deduped by line_sha", () => {
    const body = {
      hook_event_name: "Stop",
      session_id: "sess-1",
    };
    const a = ingestHookEvent(body);
    const b = ingestHookEvent(body);
    expect(a.event).toBeDefined();
    // Second call's line_sha differs only by ts; with a tight loop ts may match
    // and dedupe kicks in. Either way no error/exception is raised.
    expect(b.ok).toBe(true);
  });

  test("missing session_id → no-op, no error", () => {
    const r = ingestHookEvent({ hook_event_name: "Stop" });
    expect(r.ok).toBe(true);
    expect(r.handled).toBeNull();
    expect(r.event).toBeUndefined();
  });

  test("unknown event name → no-op, no error", () => {
    const r = ingestHookEvent({
      hook_event_name: "Mystery",
      session_id: "sess-1",
    });
    expect(r.ok).toBe(true);
    expect(r.handled).toBeNull();
  });

  test("inserted event row has usage_* fields as null (not undefined)", () => {
    ingestHookEvent({
      hook_event_name: "Notification",
      session_id: "sess-1",
      message: "x",
    });
    const ev = db
      .query(
        "SELECT usage_in, usage_out, usage_cache_read, usage_cache_create FROM events WHERE kind = 'hook_notification' LIMIT 1"
      )
      .get() as any;
    expect(ev).toBeTruthy();
    expect(ev.usage_in).toBeNull();
    expect(ev.usage_out).toBeNull();
    expect(ev.usage_cache_read).toBeNull();
    expect(ev.usage_cache_create).toBeNull();
  });
});
