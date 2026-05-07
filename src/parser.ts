import type { ParsedEvent, MessageRole, MessageType } from "./types.ts";

const PREVIEW_MAX = 4000;

function truncate(s: string, n = PREVIEW_MAX): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function flattenAssistantContent(blocks: any[]): { text: string; isToolUse: boolean; toolName?: string } {
  const parts: string[] = [];
  let isToolUse = false;
  let toolName: string | undefined;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push("[thinking] " + b.thinking);
    } else if (b.type === "tool_use") {
      isToolUse = true;
      toolName = b.name;
      const input = (() => {
        try {
          return JSON.stringify(b.input ?? {}).slice(0, 400);
        } catch {
          return "";
        }
      })();
      parts.push(`[tool:${b.name}] ${input}`);
    }
  }
  return { text: parts.join("\n\n"), isToolUse, toolName };
}

function flattenUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_result") {
      const c = b.content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) {
        for (const cb of c) {
          if (cb && typeof cb === "object" && typeof cb.text === "string") {
            parts.push(cb.text);
          }
        }
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * Parse one JSONL line. Returns null for lines we don't ingest as messages
 * (permission-mode markers, ai-title, last-prompt, file-history-snapshot, attachments).
 *
 * Accepts an optional `lineNumber` so callers can pass it through.
 */
export function parseLine(line: string): {
  event: ParsedEvent | null;
  /** raw parsed JSON; useful for sessions that derive metadata from non-message rows. */
  raw: any | null;
} {
  const trimmed = line.trim();
  if (!trimmed) return { event: null, raw: null };

  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { event: null, raw: null };
  }

  const t = raw?.type;
  // Skip non-message envelope types.
  if (t === "permission-mode" || t === "file-history-snapshot" || t === "ai-title" || t === "last-prompt") {
    return { event: null, raw };
  }
  if (t === "attachment") {
    return { event: null, raw };
  }

  const uuid: string | undefined = raw?.uuid;
  const sessionId: string | undefined = raw?.sessionId;
  const ts: string | undefined = raw?.timestamp;
  if (!uuid || !sessionId || !ts) return { event: null, raw };

  const timestamp = Date.parse(ts);
  if (Number.isNaN(timestamp)) return { event: null, raw };

  const projectPath: string | null = typeof raw?.cwd === "string" ? raw.cwd : null;
  const parentId: string | null = typeof raw?.parentUuid === "string" ? raw.parentUuid : null;

  if (t === "user") {
    const content = raw?.message?.content;
    const role: MessageRole = "user";
    const isToolReply = Array.isArray(content) && content[0]?.type === "tool_result";
    const type: MessageType = isToolReply ? "tool_result" : "text";
    const flat = flattenUserContent(content);
    return {
      event: {
        id: uuid,
        sessionId,
        parentId,
        role,
        type,
        content: JSON.stringify(content ?? null),
        textPreview: truncate(flat),
        timestamp,
        projectPath,
      },
      raw,
    };
  }

  if (t === "assistant") {
    const blocks = Array.isArray(raw?.message?.content) ? raw.message.content : [];
    const { text, isToolUse, toolName } = flattenAssistantContent(blocks);
    const firstBlock = blocks[0];
    const type: MessageType = isToolUse
      ? "tool_use"
      : firstBlock?.type === "thinking"
      ? "thinking"
      : "text";
    return {
      event: {
        id: uuid,
        sessionId,
        parentId,
        role: "assistant",
        type,
        content: JSON.stringify(blocks),
        textPreview: truncate(text),
        timestamp,
        projectPath,
        isToolUse,
        toolName,
      },
      raw,
    };
  }

  return { event: null, raw };
}

/** Pulls cwd/sessionId out of any envelope-bearing line, even non-message ones. */
export function extractSessionMetaFromRaw(raw: any): {
  sessionId: string | null;
  projectPath: string | null;
  timestamp: number | null;
} {
  if (!raw || typeof raw !== "object") return { sessionId: null, projectPath: null, timestamp: null };
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
  const projectPath = typeof raw.cwd === "string" ? raw.cwd : null;
  const tsStr = typeof raw.timestamp === "string" ? raw.timestamp : null;
  const timestamp = tsStr ? Date.parse(tsStr) : null;
  return {
    sessionId,
    projectPath,
    timestamp: timestamp != null && !Number.isNaN(timestamp) ? timestamp : null,
  };
}
