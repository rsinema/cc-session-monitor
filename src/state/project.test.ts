/**
 * Tests for the pure `project()` rule. We feed in synthetic ProjectionInput
 * shapes and assert the projected state. recomputeState() is tested separately
 * via an in-memory DB.
 */
import { describe, expect, test } from "bun:test";
import { project } from "./project.ts";
import type { EventRow } from "../db.ts";

function ev(partial: Partial<EventRow> & { id: number; ts: number; kind: EventRow["kind"] }): EventRow {
  return {
    id: partial.id,
    file_path: "/x.jsonl",
    byte_offset: 0,
    line_sha: `sha-${partial.id}`,
    session_id: "s1",
    kind: partial.kind,
    ts: partial.ts,
    uuid: `u-${partial.id}`,
    parent_uuid: null,
    tool_use_id: partial.tool_use_id ?? null,
    tool_result_id: partial.tool_result_id ?? null,
    is_sidechain: partial.is_sidechain ?? 0,
    stop_reason: partial.stop_reason ?? null,
    text_preview: partial.text_preview ?? null,
    raw: "",
  };
}

describe("project — Rule 1 (EXITED)", () => {
  test("exitedAtEvent set → EXITED", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "exit" }),
      latestNonSidechainAssistant: ev({ id: 4, ts: 90, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: 5,
    });
    expect(p.state).toBe("EXITED");
    expect(p.exited_at_event).toBe(5);
  });

  test("exit followed only by system_meta (goodbye-stdout) still → EXITED", () => {
    // Caller resolves exitedAtEvent = the exit's id when no real-user event
    // strictly follows it; system_meta does not block this.
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 6, ts: 100, kind: "system_meta" }),
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: 5,
    });
    expect(p.state).toBe("EXITED");
  });
});

describe("project — Rule 2 (open tool_use)", () => {
  test("AskUserQuestion → AWAITING_USER.question", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      openTools: [
        { tool_use_id: "toolu_q", name: "AskUserQuestion", started_at: 100, is_sidechain: 0 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("AWAITING_USER");
    expect(p.sub_state).toBe("question");
    expect(p.current_tool_use_id).toBe("toolu_q");
  });

  test("ExitPlanMode → AWAITING_USER.plan_approval", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      openTools: [
        { tool_use_id: "toolu_p", name: "ExitPlanMode", started_at: 100, is_sidechain: 0 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.sub_state).toBe("plan_approval");
  });

  test("non-blocking tool open → WORKING.tool_in_flight, picks most recent", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      openTools: [
        { tool_use_id: "toolu_a", name: "Read", started_at: 90, is_sidechain: 0 },
        { tool_use_id: "toolu_b", name: "Edit", started_at: 100, is_sidechain: 0 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
    expect(p.sub_state).toBe("tool_in_flight");
    expect(p.current_tool_use_id).toBe("toolu_b");
  });

  test("only sidechain tool open → WORKING.subagent_running", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      latestNonSidechainAssistant: null,
      openTools: [
        { tool_use_id: "toolu_s", name: "Read", started_at: 100, is_sidechain: 1 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.sub_state).toBe("subagent_running");
  });

  test("non-sidechain blocking tool wins over sidechain", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      openTools: [
        { tool_use_id: "toolu_s", name: "Read", started_at: 100, is_sidechain: 1 },
        { tool_use_id: "toolu_q", name: "AskUserQuestion", started_at: 100, is_sidechain: 0 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.sub_state).toBe("question");
  });
});

describe("project — Rule 3 (permission_prompt hook)", () => {
  test("hook flag set, no later real event → AWAITING_USER.permission_prompt", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_text" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: 110,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("AWAITING_USER");
    expect(p.sub_state).toBe("permission_prompt");
  });

  test("hook flag cleared by later user_text", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 6, ts: 120, kind: "user_text" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: 110,
      exitedAtEvent: null,
    });
    // Should fall through to Rule 5.
    expect(p.state).toBe("WORKING");
    expect(p.sub_state).toBe("streaming");
  });

  test("hook flag cleared by later tool_result", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 6, ts: 120, kind: "user_tool_result" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: 110,
      exitedAtEvent: null,
    });
    expect(p.sub_state).not.toBe("permission_prompt");
  });

  test("system_meta does NOT clear the hook flag", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 6, ts: 120, kind: "system_meta" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: 110,
      exitedAtEvent: null,
    });
    expect(p.sub_state).toBe("permission_prompt");
  });
});

describe("project — Rule 4 (end_turn)", () => {
  test("latest assistant has stop_reason=end_turn → AWAITING_USER.turn_complete", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_text", stop_reason: "end_turn" }),
      latestNonSidechainAssistant: ev({
        id: 5,
        ts: 100,
        kind: "assistant_text",
        stop_reason: "end_turn",
      }),
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.sub_state).toBe("turn_complete");
  });

  test("end_turn followed by user_text → not turn_complete", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 6, ts: 110, kind: "user_text" }),
      latestNonSidechainAssistant: ev({
        id: 5,
        ts: 100,
        kind: "assistant_text",
        stop_reason: "end_turn",
      }),
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
    expect(p.sub_state).toBe("streaming");
  });

  test("sidechain end_turn ignored (assistant from subagent doesn't end the parent's turn)", () => {
    // The latestNonSidechainAssistant input excludes sidechains by construction
    // — caller pulls it via getLatestNonSidechainAssistant. So we simulate by
    // passing null and asserting we don't claim turn_complete.
    const p = project({
      sessionId: "s1",
      latestEvent: ev({
        id: 5,
        ts: 100,
        kind: "assistant_text",
        stop_reason: "end_turn",
        is_sidechain: 1,
      }),
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.sub_state).not.toBe("turn_complete");
  });
});

describe("project — Rule 5 (user prompt with no assistant yet)", () => {
  test("latest is user_text and no other rule fires → WORKING.streaming", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "user_text" }),
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
    expect(p.sub_state).toBe("streaming");
  });
});

describe("project — Rule 6 (default)", () => {
  test("only meta envelopes seen → WORKING.streaming", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "permission_mode" }),
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
  });

  test("no events at all", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: null,
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
  });
});

describe("project — rule precedence", () => {
  test("EXITED beats hook permission prompt", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "exit" }),
      latestNonSidechainAssistant: ev({ id: 4, ts: 90, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: 110,
      exitedAtEvent: 5,
    });
    expect(p.state).toBe("EXITED");
  });

  test("open tool beats end_turn hint", () => {
    // Shouldn't normally happen (an end_turn means no open tools), but the
    // rule order should still yield WORKING / AWAITING_USER over turn_complete.
    const p = project({
      sessionId: "s1",
      latestEvent: ev({
        id: 5,
        ts: 100,
        kind: "assistant_tool_use",
        stop_reason: "tool_use",
      }),
      latestNonSidechainAssistant: ev({
        id: 4,
        ts: 90,
        kind: "assistant_text",
        stop_reason: "end_turn",
      }),
      openTools: [
        { tool_use_id: "toolu_a", name: "Read", started_at: 100, is_sidechain: 0 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
    expect(p.sub_state).toBe("tool_in_flight");
  });

  test("blocking tool beats hook flag", () => {
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 100, kind: "assistant_tool_use" }),
      openTools: [
        { tool_use_id: "toolu_q", name: "AskUserQuestion", started_at: 100, is_sidechain: 0 },
      ],
      hookPermPromptAt: 90,
      exitedAtEvent: null,
    });
    expect(p.sub_state).toBe("question");
  });
});

describe("project — state_since_ts (anchored to the triggering event)", () => {
  test("turn_complete: anchored to assistant ts, NOT to a later permission_mode envelope", () => {
    // This is the migration-artifact bug: a permission_mode row landed today,
    // but the session's last *real* activity was the assistant turn weeks ago.
    // state_since must reflect when turn_complete actually started, not when
    // the noise event landed.
    const longAgo = 1_000_000_000_000;
    const noise = longAgo + 30 * 24 * 60 * 60 * 1000; // 30 days later
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 99, ts: noise, kind: "permission_mode" }),
      latestNonSidechainAssistant: ev({
        id: 5,
        ts: longAgo,
        kind: "assistant_text",
        stop_reason: "end_turn",
      }),
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
      exitedAtTs: null,
    });
    expect(p.sub_state).toBe("turn_complete");
    expect(p.state_since_ts).toBe(longAgo);
  });

  test("EXITED: anchored to the exit event's ts", () => {
    const exitTs = 5_000;
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 99, ts: 99_999, kind: "permission_mode" }),
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: 5,
      exitedAtTs: exitTs,
    });
    expect(p.state).toBe("EXITED");
    expect(p.state_since_ts).toBe(exitTs);
  });

  test("tool_in_flight: anchored to the tool's started_at", () => {
    const startedAt = 7_777;
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 99, ts: 9_999_999, kind: "permission_mode" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: startedAt, kind: "assistant_tool_use" }),
      openTools: [
        { tool_use_id: "toolu_a", name: "Read", started_at: startedAt, is_sidechain: 0 },
      ],
      hookPermPromptAt: null,
      exitedAtEvent: null,
      exitedAtTs: null,
    });
    expect(p.sub_state).toBe("tool_in_flight");
    expect(p.state_since_ts).toBe(startedAt);
  });

  test("permission_prompt: anchored to the hook ts, not to a later meta event", () => {
    const hookAt = 2_000;
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 99, ts: 5_000, kind: "permission_mode" }),
      latestNonSidechainAssistant: ev({ id: 5, ts: 1_000, kind: "assistant_text" }),
      openTools: [],
      hookPermPromptAt: hookAt,
      exitedAtEvent: null,
      exitedAtTs: null,
    });
    expect(p.sub_state).toBe("permission_prompt");
    expect(p.state_since_ts).toBe(hookAt);
  });
});

describe("project — /exit then resume", () => {
  test("after resume, exitedAtEvent goes back to null and projection re-runs", () => {
    // Caller (recomputeState) recomputes exitedAtEvent each call. After resume,
    // it returns null. project() must then not return EXITED.
    const p = project({
      sessionId: "s1",
      latestEvent: ev({ id: 6, ts: 200, kind: "user_text" }),
      latestNonSidechainAssistant: null,
      openTools: [],
      hookPermPromptAt: null,
      exitedAtEvent: null,
    });
    expect(p.state).toBe("WORKING");
    expect(p.sub_state).toBe("streaming");
  });
});
