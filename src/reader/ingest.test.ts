/**
 * Integration tests for token accumulation and current_permission_mode.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "ccmon-ingest-"));
const DB_FILE = join(tmp, "db.sqlite");
process.env.CC_MONITOR_DB = DB_FILE;

const { db } = await import("../db.ts");
const { ingestFile } = await import("./ingest.ts");

const sessionFile = join(tmp, "session.jsonl");

let nextUuid = 0;
function nextId(): string {
  return `u-${++nextUuid}`;
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/x/y",
    sessionId: "sess-1",
    timestamp: new Date().toISOString(),
    isSidechain: false,
    parentUuid: null,
    ...overrides,
  };
}

function appendLine(obj: unknown) {
  appendFileSync(sessionFile, JSON.stringify(obj) + "\n");
}

beforeEach(() => {
  db.exec(`
    DELETE FROM events;
    DELETE FROM tool_invocations;
    DELETE FROM sessions;
    DELETE FROM file_offsets;
  `);
  writeFileSync(sessionFile, "");
});

function getSession(id = "sess-1") {
  return db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
}

describe("ingest — token accumulation", () => {
  test("session totals sum across multiple assistant events", () => {
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 100,
        },
        content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: {} }],
      },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 5,
          output_tokens: 30,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "done" }],
      },
    });
    ingestFile(sessionFile);
    const s = getSession();
    expect(s.tokens_in).toBe(15);
    expect(s.tokens_out).toBe(80);
    expect(s.tokens_cache_read).toBe(2500);
    expect(s.tokens_cache_create).toBe(100);
  });

  test("assistant without usage doesn't bump totals", () => {
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    });
    ingestFile(sessionFile);
    const s = getSession();
    expect(s.tokens_in).toBe(0);
    expect(s.tokens_out).toBe(0);
  });

  test("re-ingest of the same lines does NOT double-count", () => {
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        usage: { input_tokens: 7, output_tokens: 70 },
        content: [{ type: "text", text: "x" }],
      },
    });
    ingestFile(sessionFile);
    ingestFile(sessionFile); // idempotent — byte_offset already at end
    const s = getSession();
    expect(s.tokens_in).toBe(7);
    expect(s.tokens_out).toBe(70);
  });

  test("event row stores per-event usage so future re-aggregation is possible", () => {
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        usage: { input_tokens: 3, output_tokens: 5 },
        content: [{ type: "text", text: "x" }],
      },
    });
    ingestFile(sessionFile);
    const ev = db
      .query("SELECT usage_in, usage_out FROM events WHERE kind='assistant_text'")
      .get() as any;
    expect(ev.usage_in).toBe(3);
    expect(ev.usage_out).toBe(5);
  });
});

describe("ingest — tool_use/tool_result ordering (Claude Code occasionally inverts)", () => {
  test("tool_result line before tool_use line still closes the invocation", () => {
    // Reproduces the real-world Claude Code bug where the JSONL file has
    // tool_result on the line that comes BEFORE the matching tool_use.
    // Without the upsert, completeTool's UPDATE no-ops because the row
    // doesn't exist yet, and the tool_use later inserts an open row.
    const ts = "2026-05-08T13:59:24.000Z";
    appendLine({
      ...envelope({ timestamp: ts }),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_OUT_OF_ORDER",
            content: "result body",
          },
        ],
      },
    });
    appendLine({
      ...envelope({ timestamp: ts }),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_OUT_OF_ORDER",
            name: "Edit",
            input: { file_path: "/x" },
          },
        ],
      },
    });
    ingestFile(sessionFile);

    const tool = db
      .query("SELECT * FROM tool_invocations WHERE tool_use_id = ?")
      .get("toolu_OUT_OF_ORDER") as any;

    expect(tool).toBeTruthy();
    expect(tool.completed_at).not.toBeNull();
    expect(tool.name).toBe("Edit"); // tool_use's name overwrote the '?' placeholder
  });

  test("tool_use first then tool_result (normal order) still works", () => {
    const ts = "2026-05-08T13:59:24.000Z";
    appendLine({
      ...envelope({ timestamp: ts }),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_NORMAL", name: "Read", input: {} },
        ],
      },
    });
    appendLine({
      ...envelope({ timestamp: ts }),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_NORMAL", content: "ok" },
        ],
      },
    });
    ingestFile(sessionFile);

    const tool = db
      .query("SELECT * FROM tool_invocations WHERE tool_use_id = ?")
      .get("toolu_NORMAL") as any;

    expect(tool.completed_at).not.toBeNull();
    expect(tool.name).toBe("Read");
  });
});

describe("ingest — last_real_event_ts (noise discrimination)", () => {
  test("user/assistant/exit events bump last_real_event_ts", () => {
    const t1 = "2026-05-08T10:00:00.000Z";
    const t2 = "2026-05-08T10:00:01.000Z";
    appendLine({
      ...envelope({ timestamp: t1 }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "hi" },
    });
    appendLine({
      ...envelope({ timestamp: t2 }),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hi back" }],
      },
    });
    ingestFile(sessionFile);
    const s = getSession();
    expect(s.last_real_event_ts).toBe(Date.parse(t2));
    expect(s.last_event_ts).toBe(Date.parse(t2));
  });

  test("permission_mode does NOT bump last_real_event_ts", () => {
    const tReal = "2026-05-08T10:00:00.000Z";
    const tNoise = "2026-05-08T11:00:00.000Z";
    appendLine({
      ...envelope({ timestamp: tReal }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "hello" },
    });
    appendLine({
      type: "permission-mode",
      sessionId: "sess-1",
      permissionMode: "auto",
      timestamp: tNoise,
    });
    ingestFile(sessionFile);
    const s = getSession();
    expect(s.last_real_event_ts).toBe(Date.parse(tReal));
    // last_event_ts may move forward but real ts stays anchored.
  });

  test("ai_title does NOT bump last_real_event_ts", () => {
    const tReal = "2026-05-08T10:00:00.000Z";
    const tNoise = "2026-05-08T12:00:00.000Z";
    appendLine({
      ...envelope({ timestamp: tReal }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "x" },
    });
    appendLine({
      type: "ai-title",
      sessionId: "sess-1",
      aiTitle: "A title",
      timestamp: tNoise,
    });
    ingestFile(sessionFile);
    expect(getSession().last_real_event_ts).toBe(Date.parse(tReal));
  });

  test("system_meta (goodbye-stdout) does NOT bump last_real_event_ts", () => {
    const tExit = "2026-05-08T10:00:00.000Z";
    appendLine({
      ...envelope({ timestamp: tExit }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "<command-name>/exit</command-name>" },
    });
    appendLine({
      ...envelope({ timestamp: tExit }),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: "<local-command-stdout>Goodbye!</local-command-stdout>",
      },
    });
    ingestFile(sessionFile);
    // exit IS real → that ts should be reflected; system_meta after it must
    // not advance the field further (same ts here so this just verifies
    // the exit kind was recognized as real).
    expect(getSession().last_real_event_ts).toBe(Date.parse(tExit));
  });
});

describe("ingest — current_permission_mode", () => {
  test("latest permission_mode wins (file order)", () => {
    appendLine({ type: "permission-mode", sessionId: "sess-1", permissionMode: "default" });
    appendLine({ type: "permission-mode", sessionId: "sess-1", permissionMode: "auto" });
    appendLine({ type: "permission-mode", sessionId: "sess-1", permissionMode: "acceptEdits" });
    ingestFile(sessionFile);
    expect(getSession().current_permission_mode).toBe("acceptEdits");
  });

  test("a single permission_mode event populates the column", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "hi" },
    });
    appendLine({ type: "permission-mode", sessionId: "sess-1", permissionMode: "plan" });
    ingestFile(sessionFile);
    expect(getSession().current_permission_mode).toBe("plan");
  });

  test("no permission_mode events → column stays null", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "hi" },
    });
    ingestFile(sessionFile);
    expect(getSession().current_permission_mode).toBeNull();
  });
});
