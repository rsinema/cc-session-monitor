import { describe, expect, test } from "bun:test";
import { formatAwaitingMessage } from "./webhooks.ts";
import type { SessionRow } from "../db.ts";

function mkSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "abc123def456",
    project_path: "/x/y",
    project_name: "monitor",
    title: null,
    file_path: "/tmp/x.jsonl",
    started_at: 1000,
    last_event_ts: 1000,
    last_real_event_ts: 1000,
    state: "AWAITING_USER",
    sub_state: "permission_prompt",
    state_since: 1000,
    current_tool_use_id: null,
    exited_at_event: null,
    hook_perm_prompt_at: null,
    current_permission_mode: null,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_create: 0,
    archived_at: null,
    ...overrides,
  };
}

describe("formatAwaitingMessage", () => {
  test("uses project name when there's no title", () => {
    const msg = formatAwaitingMessage(
      { session: mkSession(), subState: "permission_prompt" },
      null
    );
    expect(msg).toBe("monitor · permission prompt");
  });

  test("includes title when present", () => {
    const msg = formatAwaitingMessage(
      {
        session: mkSession({ title: "Fixing the dispatch bug" }),
        subState: "turn_complete",
      },
      null
    );
    expect(msg).toBe("monitor — Fixing the dispatch bug · turn complete");
  });

  test("appends a session link when MONITOR_PUBLIC_URL is set", () => {
    const msg = formatAwaitingMessage(
      { session: mkSession(), subState: "question" },
      "http://monitor.local:3737"
    );
    expect(msg).toContain("http://monitor.local:3737/#/session/abc123def456");
  });

  test("strips trailing slash from public URL before appending", () => {
    const msg = formatAwaitingMessage(
      { session: mkSession(), subState: "plan_approval" },
      "http://monitor.local:3737/"
    );
    expect(msg).toContain("monitor.local:3737/#/session/");
    expect(msg).not.toContain("3737//#");
  });
});
