/**
 * Integration tests for recomputeState() — exercise the full pipeline against
 * a temp DB built by ingesting synthetic JSONL.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "ccmon-v2-"));
const DB_FILE = join(tmp, "db.sqlite");
process.env.CC_MONITOR_DB = DB_FILE;

// Imports must be after env var is set so db.ts picks up the test DB path.
const { db } = await import("../db.ts");
const { ingestFile } = await import("../reader/ingest.ts");
const { recomputeState } = await import("./project.ts");
const { ingestHookEvent } = await import("./hooks.ts");

const sessionFile = join(tmp, "session.jsonl");

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

let nextUuid = 0;
function nextId(): string {
  return `u-${++nextUuid}`;
}

function appendLine(obj: unknown) {
  appendFileSync(sessionFile, JSON.stringify(obj) + "\n");
}

beforeAll(() => {
  writeFileSync(sessionFile, "");
});

beforeEach(() => {
  // Reset DB between tests by truncating tables.
  db.exec(`
    DELETE FROM events;
    DELETE FROM tool_invocations;
    DELETE FROM sessions;
    DELETE FROM file_offsets;
  `);
  writeFileSync(sessionFile, "");
});

function ingest() {
  return ingestFile(sessionFile);
}

describe("recomputeState — happy path", () => {
  test("user_text only → WORKING.streaming", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "hi" },
    });
    ingest();
    const r = recomputeState("sess-1");
    expect(r.after.state).toBe("WORKING");
    expect(r.after.sub_state).toBe("streaming");
  });

  test("assistant tool_use → WORKING.tool_in_flight", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "do a thing" },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
      },
    });
    ingest();
    const r = recomputeState("sess-1");
    expect(r.after.state).toBe("WORKING");
    expect(r.after.sub_state).toBe("tool_in_flight");
    expect(r.after.current_tool_use_id).toBe("toolu_1");
  });

  test("tool_use → tool_result → assistant text + end_turn → AWAITING_USER.turn_complete", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "do it" },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
      },
    });
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    });
    ingest();
    const r = recomputeState("sess-1");
    expect(r.after.state).toBe("AWAITING_USER");
    expect(r.after.sub_state).toBe("turn_complete");
  });

  test("AskUserQuestion blocking tool → AWAITING_USER.question", () => {
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: {} },
        ],
      },
    });
    ingest();
    const r = recomputeState("sess-1");
    expect(r.after.sub_state).toBe("question");
    expect(r.after.current_tool_use_id).toBe("toolu_q");
  });
});

describe("recomputeState — /exit handling", () => {
  test("/exit triplet → EXITED, even with same-ts goodbye-stdout", () => {
    const ts = new Date().toISOString();
    appendLine({
      ...envelope({ timestamp: ts }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "<command-name>/exit</command-name>" },
    });
    appendLine({
      ...envelope({ timestamp: ts }),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: "<local-command-stdout>Goodbye!</local-command-stdout>",
      },
    });
    ingest();
    const r = recomputeState("sess-1");
    expect(r.after.state).toBe("EXITED");
  });

  test("/exit + resume → not EXITED", () => {
    const ts1 = "2026-05-07T00:00:00.000Z";
    const ts2 = "2026-05-07T00:01:00.000Z";
    appendLine({
      ...envelope({ timestamp: ts1 }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "<command-name>/exit</command-name>" },
    });
    appendLine({
      ...envelope({ timestamp: ts1 }),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: "<local-command-stdout>Goodbye!</local-command-stdout>",
      },
    });
    appendLine({
      ...envelope({ timestamp: ts2 }),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "back" },
    });
    ingest();
    const r = recomputeState("sess-1");
    expect(r.after.state).toBe("WORKING");
  });
});

describe("recomputeState — incremental ingest", () => {
  test("appending a new line and re-ingesting projects new state", () => {
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
      },
    });
    ingest();
    let r = recomputeState("sess-1");
    expect(r.after.sub_state).toBe("tool_in_flight");

    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    });
    ingest();
    r = recomputeState("sess-1");
    expect(r.after.sub_state).toBe("turn_complete");
  });

  test("re-ingesting the same file is a no-op (idempotent)", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "x" },
    });
    const a = ingest();
    const b = ingest();
    expect(a.newEvents.length).toBe(1);
    expect(b.newEvents.length).toBe(0);
  });
});

describe("recomputeState — permission_prompt hook lifecycle", () => {
  test("permission_prompt clears after the user approves and the assistant resumes", () => {
    // Regression for the bug where a session that hit a permission prompt
    // earlier in the turn was reported as "Permission" even after the user
    // approved and the assistant finished its reply. Old code only checked
    // whether *the latest* event was a real user event, which fails as soon
    // as the assistant streams more text on top of the tool_result.
    //
    // Sequence (no longer-open tool by the end):
    //   user_text → assistant_tool_use → Notification hook fires →
    //   user_tool_result (tool completes) → assistant_text + end_turn.
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "do it" },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
      },
    });
    ingest();

    // Claude Code asks for permission while the tool is still open. Rule 2
    // wins here (tool_in_flight) — the hook flag is parked for later.
    ingestHookEvent({
      hook_event_name: "Notification",
      session_id: "sess-1",
      message: "Claude needs your permission to use Bash",
    });
    let r = recomputeState("sess-1");
    expect(r.after.sub_state).toBe("tool_in_flight");

    // User approves → tool_result lands → assistant streams text + end_turn.
    // The latest event is now the assistant message, NOT the tool_result.
    // Previously this snapped back to permission_prompt; now it should land
    // on turn_complete.
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    });
    ingest();
    r = recomputeState("sess-1");
    expect(r.after.sub_state).not.toBe("permission_prompt");
    expect(r.after.sub_state).toBe("turn_complete");
  });
});

describe("recomputeState — sidechain", () => {
  test("sidechain end_turn doesn't flip parent to turn_complete", () => {
    appendLine({
      ...envelope(),
      type: "user",
      uuid: nextId(),
      message: { role: "user", content: "go" },
    });
    appendLine({
      ...envelope(),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_t", name: "Task", input: {} }],
      },
    });
    appendLine({
      ...envelope({ isSidechain: true }),
      type: "assistant",
      uuid: nextId(),
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "subagent done" }],
      },
    });
    ingest();
    const r = recomputeState("sess-1");
    // Parent's Task tool is still open, so this is tool_in_flight.
    expect(r.after.state).toBe("WORKING");
    expect(r.after.sub_state).toBe("tool_in_flight");
  });
});
