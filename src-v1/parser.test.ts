import { describe, expect, test } from "bun:test";
import { parseLine } from "./parser.ts";

describe("parseLine", () => {
  test("ignores meta-types", () => {
    expect(
      parseLine(JSON.stringify({ type: "permission-mode", permissionMode: "auto", sessionId: "s1" }))
        .event
    ).toBeNull();
    expect(
      parseLine(
        JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: {}, isSnapshotUpdate: false })
      ).event
    ).toBeNull();
    expect(parseLine(JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "x" })).event).toBeNull();
  });

  test("user string content -> text", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "s1",
      parentUuid: null,
      timestamp: "2026-05-07T15:58:01.000Z",
      cwd: "/x/y",
      message: { role: "user", content: "hello" },
    });
    const { event } = parseLine(line);
    expect(event).not.toBeNull();
    expect(event!.role).toBe("user");
    expect(event!.type).toBe("text");
    expect(event!.textPreview).toBe("hello");
    expect(event!.projectPath).toBe("/x/y");
    expect(event!.parentId).toBeNull();
  });

  test("user tool_result -> tool_result type", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u2",
      sessionId: "s1",
      parentUuid: "u1",
      timestamp: "2026-05-07T15:58:02.000Z",
      cwd: "/x/y",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }],
      },
    });
    const { event } = parseLine(line);
    expect(event!.type).toBe("tool_result");
    expect(event!.textPreview).toBe("ok");
  });

  test("assistant tool_use detected", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      sessionId: "s1",
      parentUuid: "u1",
      timestamp: "2026-05-07T15:58:03.000Z",
      cwd: "/x/y",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "/foo" } }],
      },
    });
    const { event } = parseLine(line);
    expect(event!.role).toBe("assistant");
    expect(event!.type).toBe("tool_use");
    expect(event!.isToolUse).toBe(true);
    expect(event!.toolName).toBe("Read");
    expect(event!.textPreview).toContain("[tool:Read]");
  });

  test("assistant text + thinking flatten", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "a2",
      sessionId: "s1",
      parentUuid: "u1",
      timestamp: "2026-05-07T15:58:04.000Z",
      cwd: "/x/y",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ponder" },
          { type: "text", text: "hi" },
        ],
      },
    });
    const { event } = parseLine(line);
    expect(event!.type).toBe("thinking");
    expect(event!.textPreview).toContain("[thinking] ponder");
    expect(event!.textPreview).toContain("hi");
  });

  test("garbage line returns null", () => {
    expect(parseLine("not json").event).toBeNull();
    expect(parseLine("").event).toBeNull();
  });
});
