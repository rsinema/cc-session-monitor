import { describe, expect, test } from "bun:test";
import { parseLine } from "./parse.ts";

const baseEnvelope = {
  cwd: "/x/y",
  sessionId: "s1",
  timestamp: "2026-05-07T15:58:01.000Z",
  isSidechain: false,
  parentUuid: null,
};

describe("parseLine", () => {
  test("ignores noise types", () => {
    expect(parseLine(JSON.stringify({ type: "file-history-snapshot" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "last-prompt", sessionId: "s1" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "attachment", attachment: {} }))).toBeNull();
    expect(parseLine("not json")).toBeNull();
    expect(parseLine("")).toBeNull();
  });

  test("permission-mode kept as event", () => {
    const r = parseLine(
      JSON.stringify({
        type: "permission-mode",
        permissionMode: "auto",
        sessionId: "s1",
        timestamp: "2026-05-07T00:00:00.000Z",
      })
    );
    expect(r?.kind).toBe("permission_mode");
    expect(r?.textPreview).toBe("auto");
  });

  test("ai-title kept as event", () => {
    const r = parseLine(
      JSON.stringify({
        type: "ai-title",
        aiTitle: " refactoring plan ",
        sessionId: "s1",
        timestamp: "2026-05-07T00:00:00.000Z",
      })
    );
    expect(r?.kind).toBe("ai_title");
    expect(r?.aiTitle).toBe("refactoring plan");
  });

  test("user string content -> user_text", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hello world" },
      })
    );
    expect(r?.kind).toBe("user_text");
    expect(r?.textPreview).toBe("hello world");
    expect(r?.allToolResultIds).toEqual([]);
  });

  test("user /exit command -> exit kind", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content:
            "<command-name>/exit</command-name><command-message>exit</command-message><command-args></command-args>",
        },
      })
    );
    expect(r?.kind).toBe("exit");
  });

  test("user tool_result with multiple ids -> user_tool_result, all ids captured", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "ok" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "ok2" },
          ],
        },
      })
    );
    expect(r?.kind).toBe("user_tool_result");
    expect(r?.toolResultId).toBe("toolu_a");
    expect(r?.allToolResultIds).toEqual(["toolu_a", "toolu_b"]);
    expect(r?.textPreview).toContain("ok");
    expect(r?.textPreview).toContain("ok2");
  });

  test("assistant tool_use captured with all ids", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/x" } },
            { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "ls" } },
          ],
        },
      })
    );
    expect(r?.kind).toBe("assistant_tool_use");
    expect(r?.toolUseId).toBe("toolu_a");
    expect(r?.allToolUseIds).toEqual(["toolu_a", "toolu_b"]);
    expect(r?.allToolNames).toEqual(["Read", "Bash"]);
    expect(r?.toolName).toBe("Read");
    expect(r?.stopReason).toBe("tool_use");
  });

  test("assistant text + thinking -> assistant_text (text wins)", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "assistant",
        uuid: "a2",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: "ponder" },
            { type: "text", text: "hi" },
          ],
        },
      })
    );
    expect(r?.kind).toBe("assistant_text");
    expect(r?.stopReason).toBe("end_turn");
    expect(r?.textPreview).toContain("[thinking] ponder");
    expect(r?.textPreview).toContain("hi");
  });

  test("assistant thinking-only -> assistant_thinking", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "assistant",
        uuid: "a3",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal" }],
        },
      })
    );
    expect(r?.kind).toBe("assistant_thinking");
  });

  test("isSidechain propagates", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        isSidechain: true,
        type: "assistant",
        uuid: "a4",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "subagent done" }],
        },
      })
    );
    expect(r?.isSidechain).toBe(1);
  });

  test("line_sha is stable", () => {
    const line = JSON.stringify({
      ...baseEnvelope,
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "hello" },
    });
    const a = parseLine(line);
    const b = parseLine(line);
    expect(a?.lineSha).toBe(b!.lineSha);
  });

  test("assistant message.usage is captured on the parsed row", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "assistant",
        uuid: "a-usage",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 200,
            cache_read_input_tokens: 1500,
            cache_creation_input_tokens: 30,
          },
          content: [{ type: "text", text: "hi" }],
        },
      })
    );
    expect(r?.usageIn).toBe(5);
    expect(r?.usageOut).toBe(200);
    expect(r?.usageCacheRead).toBe(1500);
    expect(r?.usageCacheCreate).toBe(30);
  });

  test("assistant without message.usage → all usage fields null", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "assistant",
        uuid: "a-no-usage",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      })
    );
    expect(r?.usageIn).toBeNull();
    expect(r?.usageOut).toBeNull();
    expect(r?.usageCacheRead).toBeNull();
    expect(r?.usageCacheCreate).toBeNull();
  });

  test("permission-mode value flows through as parsed.permissionMode", () => {
    const r = parseLine(
      JSON.stringify({ type: "permission-mode", permissionMode: "auto", sessionId: "s1" })
    );
    expect(r?.kind).toBe("permission_mode");
    expect(r?.permissionMode).toBe("auto");
  });

  test("permission-mode with empty value → permissionMode is null", () => {
    const r = parseLine(
      JSON.stringify({ type: "permission-mode", permissionMode: "", sessionId: "s1" })
    );
    expect(r?.permissionMode).toBeNull();
  });

  test("user events have permissionMode null", () => {
    const r = parseLine(
      JSON.stringify({
        ...baseEnvelope,
        type: "user",
        uuid: "u-x",
        message: { role: "user", content: "hi" },
      })
    );
    expect(r?.permissionMode).toBeNull();
  });
});
