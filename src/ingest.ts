import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { db, stmts } from "./db.ts";
import { parseLine, extractSessionMetaFromRaw } from "./parser.ts";
import { macNotify } from "./notify.ts";
import type { ParsedEvent } from "./types.ts";

/** Tool calls that block the assistant turn until the user responds. */
const BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function findBlockingToolUse(parsed: any): { id: string; name: string } | null {
  if (parsed?.type !== "assistant") return null;
  const blocks = parsed?.message?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b?.type === "tool_use" && BLOCKING_TOOLS.has(b.name) && typeof b.id === "string") {
      return { id: b.id, name: b.name };
    }
  }
  return null;
}

function findToolResultIds(parsed: any): string[] {
  if (parsed?.type !== "user") return [];
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const b of content) {
    if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
      ids.push(b.tool_use_id);
    }
  }
  return ids;
}

/**
 * Re-read a session file from the last persisted line offset and ingest new lines.
 * Idempotent: re-running on an unchanged file is a no-op.
 *
 * Returns the new ParsedEvents that were inserted (deduped) and the session IDs touched,
 * so callers (e.g. the SSE broadcaster) can notify subscribers.
 */
export function ingestFile(filePath: string): {
  newEvents: ParsedEvent[];
  touchedSessions: Set<string>;
} {
  const newEvents: ParsedEvent[] = [];
  const touchedSessions = new Set<string>();

  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return { newEvents, touchedSessions };
  }
  if (!stats.isFile() || !filePath.endsWith(".jsonl")) {
    return { newEvents, touchedSessions };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { newEvents, touchedSessions };
  }

  const lines = raw.split("\n");
  const lastLineRow = stmts.getOffset.get(filePath) as { last_line: number } | undefined;
  const startIdx = lastLineRow?.last_line ?? 0;

  // Walk newly added lines.
  const sessionFirstSeen = new Map<string, { ts: number; cwd: string | null; sessionId: string }>();
  const sessionLastSeen = new Map<string, number>();

  const tx = db.transaction(() => {
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const { event, raw: parsed } = parseLine(line);

      // Pull metadata out of every envelope-bearing line so we can create sessions
      // even before the first user/assistant message arrives.
      const meta = extractSessionMetaFromRaw(parsed);
      if (meta.sessionId && meta.timestamp != null) {
        const cur = sessionFirstSeen.get(meta.sessionId);
        if (!cur || meta.timestamp < cur.ts) {
          sessionFirstSeen.set(meta.sessionId, {
            ts: meta.timestamp,
            cwd: meta.projectPath,
            sessionId: meta.sessionId,
          });
        }
        const prevLast = sessionLastSeen.get(meta.sessionId) ?? 0;
        if (meta.timestamp > prevLast) sessionLastSeen.set(meta.sessionId, meta.timestamp);
      }

      if (!event) continue;

      // Ensure the session row exists / metadata is fresh.
      const existing = stmts.getSessionById.get(event.sessionId) as
        | { id: string; project_path: string }
        | undefined;
      const projectPath = event.projectPath ?? existing?.project_path ?? sessionIdToProjectPath(filePath);
      const projectName = basename(projectPath);
      stmts.upsertSession.run(
        event.sessionId,
        projectPath,
        projectName,
        event.timestamp,
        event.timestamp,
        filePath
      );

      const lineNumber = i + 1;
      const result = stmts.insertMessage.run(
        event.id,
        event.sessionId,
        event.parentId,
        event.role,
        event.type,
        event.content,
        event.textPreview,
        event.timestamp,
        lineNumber
      );

      // changes === 1 means it was actually inserted (not ignored as duplicate).
      const isFresh = result.changes > 0;
      if (isFresh) {
        newEvents.push(event);
      }

      stmts.bumpSessionAfterMessage.run(event.timestamp, event.timestamp, event.sessionId);

      // Blocking tool_use → flip awaiting and notify (only on fresh ingestion to avoid backfill spam).
      const blocking = findBlockingToolUse(parsed);
      if (blocking) {
        stmts.setAwaitingByToolUse.run(blocking.id, event.sessionId);
        if (isFresh) {
          const projectName = basename(projectPath);
          macNotify("Claude Code", `${projectName}: awaiting your input (${blocking.name})`);
        }
      }

      // tool_result(s) → clear awaiting iff the tool id matches the one we recorded.
      for (const trId of findToolResultIds(parsed)) {
        stmts.clearAwaitingByToolResult.run(event.sessionId, trId);
      }

      // A new user-typed message implies the user moved on; clear any awaiting state.
      if (event.role === "user" && event.type === "text") {
        stmts.clearAwaitingInputForSession.run(event.sessionId);
      }
      touchedSessions.add(event.sessionId);
    }

    // Even if a file has only meta-types (no user/assistant yet), create a stub session row
    // so the UI can show "session started" entries.
    for (const [sessionId, info] of sessionFirstSeen) {
      const last = sessionLastSeen.get(sessionId) ?? info.ts;
      const cwd = info.cwd ?? sessionIdToProjectPath(filePath);
      stmts.upsertSession.run(sessionId, cwd, basename(cwd), info.ts, last, filePath);
      touchedSessions.add(sessionId);
    }

    // Persist new offset so we resume from here next time.
    stmts.setOffset.run(filePath, lines.length);
  });

  tx();

  return { newEvents, touchedSessions };
}

/**
 * Decode a Claude Code project slug like
 *   "-Users-riley-code-enzy" → "/Users/riley/code/enzy"
 * Slugs replace `/` with `-` in the absolute path. Best-effort fallback when
 * envelope cwd is unavailable.
 */
export function sessionIdToProjectPath(filePath: string): string {
  // filePath looks like .../.claude/projects/<slug>/<sessionId>.jsonl
  const m = filePath.match(/\.claude\/projects\/([^/]+)\//);
  if (!m) return "";
  const slug = m[1]!;
  // Slug is "-Users-..." — leading "-" became "/", subsequent "-" became "/".
  return slug.replaceAll("-", "/");
}
