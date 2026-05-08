import { createHash } from "node:crypto";
import type { EventKind } from "../db.ts";

const PREVIEW_MAX = 4000;

function truncate(s: string, n = PREVIEW_MAX): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function flattenAssistantContent(blocks: any[]): {
  text: string;
  toolUseIds: string[];
  toolNames: string[];
  hasText: boolean;
  hasThinking: boolean;
  hasToolUse: boolean;
} {
  const parts: string[] = [];
  const toolUseIds: string[] = [];
  const toolNames: string[] = [];
  let hasText = false;
  let hasThinking = false;
  let hasToolUse = false;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      hasText = true;
      parts.push(b.text);
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      hasThinking = true;
      parts.push("[thinking] " + b.thinking);
    } else if (b.type === "tool_use") {
      hasToolUse = true;
      if (typeof b.id === "string") toolUseIds.push(b.id);
      if (typeof b.name === "string") toolNames.push(b.name);
      let input = "";
      try {
        input = JSON.stringify(b.input ?? {}).slice(0, 400);
      } catch {
        input = "";
      }
      parts.push(`[tool:${b.name ?? "?"}] ${input}`);
    }
  }
  return {
    text: parts.join("\n\n"),
    toolUseIds,
    toolNames,
    hasText,
    hasThinking,
    hasToolUse,
  };
}

function flattenUserContent(content: unknown): {
  text: string;
  toolResultIds: string[];
  isToolResult: boolean;
} {
  if (typeof content === "string") {
    return { text: content, toolResultIds: [], isToolResult: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", toolResultIds: [], isToolResult: false };
  }
  const parts: string[] = [];
  const toolResultIds: string[] = [];
  let isToolResult = false;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_result") {
      isToolResult = true;
      if (typeof b.tool_use_id === "string") toolResultIds.push(b.tool_use_id);
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
  return { text: parts.join("\n\n"), toolResultIds, isToolResult };
}

/** True iff the line is a /exit command (Claude Code's invariant marker). */
function isExitCommand(text: string): boolean {
  return text.includes("<command-name>/exit</command-name>");
}

/**
 * True iff a user_text body is just a Claude Code system tag (goodbye stdout,
 * caveat banner, etc.). These look like user messages on the wire but are
 * auto-injected by Claude Code itself. Detected by being entirely wrapped in
 * one of the known `<local-command-*>` tags after trimming.
 */
function isSystemMeta(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("<local-command-")) return false;
  // Single tag form, e.g. <local-command-stdout>Goodbye!</local-command-stdout>
  // (whitespace allowed). It's enough that the body opens with one of these
  // and contains no plain prose outside the tag pair.
  return /^<local-command-(stdout|stderr|caveat)>[\s\S]*<\/local-command-(stdout|stderr|caveat)>\s*$/.test(
    t
  );
}

export interface ParsedRow {
  /** Stable hash of the original line text for dedupe across re-reads. */
  lineSha: string;
  sessionId: string | null;
  kind: EventKind;
  ts: number;
  uuid: string | null;
  parentUuid: string | null;
  /** First tool_use id in an assistant tool_use event (multi-tool turns are rare). */
  toolUseId: string | null;
  /** First tool_result id in a user tool_result event. */
  toolResultId: string | null;
  isSidechain: number;
  stopReason: string | null;
  textPreview: string;
  /** The full original JSONL line. */
  raw: string;
  /** Tool name, when kind === assistant_tool_use. */
  toolName: string | null;
  /** Title, when kind === ai_title. */
  aiTitle: string | null;
  /** Project cwd, if present on the envelope. */
  projectPath: string | null;
  /** All tool_use ids in this assistant turn — set up tool_invocations rows for each. */
  allToolUseIds: string[];
  /** All tool names corresponding to allToolUseIds. */
  allToolNames: string[];
  /** All tool_result ids in this user turn — close tool_invocations for each. */
  allToolResultIds: string[];
  /** message.usage on assistant events. Null when the field is absent. */
  usageIn: number | null;
  usageOut: number | null;
  usageCacheRead: number | null;
  usageCacheCreate: number | null;
  /** Permission mode value (auto/default/acceptEdits/plan), only on permission_mode kind. */
  permissionMode: string | null;
}

function extractUsage(message: any): {
  usageIn: number | null;
  usageOut: number | null;
  usageCacheRead: number | null;
  usageCacheCreate: number | null;
} {
  const u = message?.usage;
  if (!u || typeof u !== "object") {
    return { usageIn: null, usageOut: null, usageCacheRead: null, usageCacheCreate: null };
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    usageIn: num(u.input_tokens),
    usageOut: num(u.output_tokens),
    usageCacheRead: num(u.cache_read_input_tokens),
    usageCacheCreate: num(u.cache_creation_input_tokens),
  };
}

/**
 * Parse one JSONL line into a ParsedRow. Returns null for lines we don't ingest
 * at all (file-history-snapshot, last-prompt, attachment, garbage).
 *
 * v1 dropped `permission-mode` and `ai-title` rows here too; v2 keeps them as
 * events so future projections (mode tracking, title backfill) can read them
 * from the events table without a separate scan.
 */
export function parseLine(line: string): ParsedRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const t = raw?.type;
  if (
    t === "file-history-snapshot" ||
    t === "last-prompt" ||
    t === "attachment"
  ) {
    return null;
  }

  const sessionId: string | null =
    typeof raw?.sessionId === "string" ? raw.sessionId : null;
  const tsStr: string | null = typeof raw?.timestamp === "string" ? raw.timestamp : null;
  const tsParsed = tsStr ? Date.parse(tsStr) : NaN;
  const ts = Number.isFinite(tsParsed) ? tsParsed : Date.now();

  const projectPath: string | null = typeof raw?.cwd === "string" ? raw.cwd : null;
  const uuid: string | null = typeof raw?.uuid === "string" ? raw.uuid : null;
  const parentUuid: string | null =
    typeof raw?.parentUuid === "string" ? raw.parentUuid : null;
  const isSidechain = raw?.isSidechain === true ? 1 : 0;

  if (t === "permission-mode") {
    const mode = typeof raw?.permissionMode === "string" ? raw.permissionMode : "";
    return {
      lineSha: sha1(trimmed),
      sessionId,
      kind: "permission_mode",
      ts,
      uuid,
      parentUuid,
      toolUseId: null,
      toolResultId: null,
      isSidechain,
      stopReason: null,
      textPreview: mode,
      raw: trimmed,
      toolName: null,
      aiTitle: null,
      projectPath,
      allToolUseIds: [],
      allToolNames: [],
      allToolResultIds: [],
      usageIn: null,
      usageOut: null,
      usageCacheRead: null,
      usageCacheCreate: null,
      permissionMode: mode || null,
    };
  }

  if (t === "ai-title") {
    const title = typeof raw?.aiTitle === "string" ? raw.aiTitle.trim() : "";
    return {
      lineSha: sha1(trimmed),
      sessionId,
      kind: "ai_title",
      ts,
      uuid,
      parentUuid,
      toolUseId: null,
      toolResultId: null,
      isSidechain,
      stopReason: null,
      textPreview: title,
      raw: trimmed,
      toolName: null,
      aiTitle: title || null,
      projectPath,
      allToolUseIds: [],
      allToolNames: [],
      allToolResultIds: [],
      usageIn: null,
      usageOut: null,
      usageCacheRead: null,
      usageCacheCreate: null,
      permissionMode: null,
    };
  }

  if (t === "user") {
    if (!sessionId || !uuid) return null;
    const content = raw?.message?.content;
    const flat = flattenUserContent(content);
    let kind: EventKind;
    if (flat.isToolResult) kind = "user_tool_result";
    else if (isExitCommand(flat.text)) kind = "exit";
    else if (isSystemMeta(flat.text)) kind = "system_meta";
    else kind = "user_text";
    return {
      lineSha: sha1(trimmed),
      sessionId,
      kind,
      ts,
      uuid,
      parentUuid,
      toolUseId: null,
      toolResultId: flat.toolResultIds[0] ?? null,
      isSidechain,
      stopReason: null,
      textPreview: truncate(flat.text),
      raw: trimmed,
      toolName: null,
      aiTitle: null,
      projectPath,
      allToolUseIds: [],
      allToolNames: [],
      allToolResultIds: flat.toolResultIds,
      usageIn: null,
      usageOut: null,
      usageCacheRead: null,
      usageCacheCreate: null,
      permissionMode: null,
    };
  }

  if (t === "assistant") {
    if (!sessionId || !uuid) return null;
    const blocks = Array.isArray(raw?.message?.content) ? raw.message.content : [];
    const f = flattenAssistantContent(blocks);
    const stopReason =
      typeof raw?.message?.stop_reason === "string" ? raw.message.stop_reason : null;
    const usage = extractUsage(raw?.message);
    let kind: EventKind;
    if (f.hasToolUse) kind = "assistant_tool_use";
    else if (f.hasThinking && !f.hasText) kind = "assistant_thinking";
    else kind = "assistant_text";
    return {
      lineSha: sha1(trimmed),
      sessionId,
      kind,
      ts,
      uuid,
      parentUuid,
      toolUseId: f.toolUseIds[0] ?? null,
      toolResultId: null,
      isSidechain,
      stopReason,
      textPreview: truncate(f.text),
      raw: trimmed,
      toolName: f.toolNames[0] ?? null,
      aiTitle: null,
      projectPath,
      allToolUseIds: f.toolUseIds,
      allToolNames: f.toolNames,
      allToolResultIds: [],
      usageIn: usage.usageIn,
      usageOut: usage.usageOut,
      usageCacheRead: usage.usageCacheRead,
      usageCacheCreate: usage.usageCacheCreate,
      permissionMode: null,
    };
  }

  return null;
}
