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

      // ai-title rows often appear without timestamp/cwd, so they don't go through
      // the meta block above. Stamp the title directly on the session row.
      if (meta.sessionId && meta.aiTitle) {
        stmts.setTitle.run(meta.aiTitle, meta.sessionId);
        touchedSessions.add(meta.sessionId);
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

      // Assistant `stop_reason: end_turn` is the deterministic signal that the
      // turn is fully complete and the user is needed next. Catches cases the
      // Stop hook can't (e.g. server reloading when notify.sh fired).
      // Gates:
      //   - isFresh:      only on a newly-ingested message; re-reading old end_turns
      //                   on boot/migration must not retroactively flag old sessions.
      //   - !isSidechain: subagent turns complete independently of the parent.
      //   - !exited_at:   /exit wins; never resurrect an exited session as awaiting.
      if (
        isFresh &&
        event.role === "assistant" &&
        event.stopReason === "end_turn" &&
        !event.isSidechain
      ) {
        const sess = stmts.getSessionById.get(event.sessionId) as any;
        if (!sess?.exited_at) {
          stmts.setAwaitingInput.run(1, event.sessionId);
        }
      }

      // A new user-typed message implies the user moved on; clear any awaiting state.
      if (event.role === "user" && event.type === "text") {
        stmts.clearAwaitingInputForSession.run(event.sessionId);
        // `/exit` writes a triplet (caveat / command / goodbye-stdout) all at
        // the same timestamp. Match the invariant `<command-name>/exit</command-name>`
        // tag — the goodbye text is randomized.
        if (event.textPreview?.includes("<command-name>/exit</command-name>")) {
          stmts.markExited.run(event.timestamp, event.sessionId);
        }
      }
      // Any strictly-later real message (assistant turn, tool_result, or a
      // user message past the exit triplet) means the session resumed —
      // clear the exited flag.
      stmts.clearExitedIfBefore.run(event.sessionId, event.timestamp);
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
    //
    // We save `lines.length - 1` (the index of the trailing empty string from
    // split, or the partial last line if the file doesn't end in \n) rather
    // than `lines.length`. The old "lines.length" semantics caused an off-by-
    // one where a future ingest would start past the latest real line — when
    // a new line was appended, the loop would land on the new trailing "" and
    // skip the actual content. Re-processing the last index each pass is
    // cheap (INSERT OR IGNORE) and bullet-proof.
    stmts.setOffset.run(filePath, Math.max(0, lines.length - 1));
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
