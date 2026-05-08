import { statSync } from "node:fs";
import { basename } from "node:path";
import { db, stmts, type EventRow } from "../db.ts";
import { parseLine, type ParsedRow } from "./parse.ts";
import { tailFile } from "./tail.ts";

export interface IngestResult {
  /** Newly inserted event rows, in file order. */
  newEvents: EventRow[];
  /** Sessions touched by this ingest pass (for SSE broadcast). */
  touchedSessions: Set<string>;
}

/**
 * Read newly-appended lines from `filePath` and insert them as events. Returns
 * the new rows so callers can drive state recomputation + SSE.
 *
 * Idempotent on (file_path, byte_offset) AND on line_sha — re-reading an
 * unchanged or re-rotated file doesn't double-insert.
 */
export function ingestFile(filePath: string): IngestResult {
  const newEvents: EventRow[] = [];
  const touchedSessions = new Set<string>();

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { newEvents, touchedSessions };
  }
  if (!stat.isFile() || !filePath.endsWith(".jsonl")) {
    return { newEvents, touchedSessions };
  }

  const prev = stmts.getOffset.get(filePath) as
    | { byte_offset: number; inode: number | null; last_size: number }
    | undefined;
  const prevOffset = prev?.byte_offset ?? 0;
  const prevInode = prev?.inode ?? null;

  const tail = tailFile(filePath, prevOffset, prevInode);
  if (tail.lines.length === 0 && !tail.rotated) {
    // Fast path: persist the latest size/inode but no events to emit.
    stmts.setOffset.run(filePath, tail.newOffset, tail.inode, tail.size, Date.now());
    return { newEvents, touchedSessions };
  }

  const projectPathFromSlug = sessionFilePathToProjectPath(filePath);

  const tx = db.transaction(() => {
    for (const { text, offset } of tail.lines) {
      const parsed = parseLine(text);
      if (!parsed) continue;

      // Insert event row (deduped by file_path/byte_offset and by line_sha).
      let insertedId: number | null;
      try {
        const ret = stmts.insertEvent.get(
          filePath,
          offset,
          parsed.lineSha,
          parsed.sessionId,
          parsed.kind,
          parsed.ts,
          parsed.uuid,
          parsed.parentUuid,
          parsed.toolUseId,
          parsed.toolResultId,
          parsed.isSidechain,
          parsed.stopReason,
          parsed.textPreview,
          parsed.raw,
          parsed.usageIn,
          parsed.usageOut,
          parsed.usageCacheRead,
          parsed.usageCacheCreate
        ) as { id: number } | undefined;
        insertedId = ret?.id ?? null;
      } catch (err) {
        // Unique-violation on line_sha (same line ingested via a different
        // offset, e.g. file rotation copied content) — skip.
        if (String(err).includes("UNIQUE")) continue;
        throw err;
      }
      if (insertedId == null) continue;

      const ev: EventRow = {
        id: insertedId,
        file_path: filePath,
        byte_offset: offset,
        line_sha: parsed.lineSha,
        session_id: parsed.sessionId,
        kind: parsed.kind,
        ts: parsed.ts,
        uuid: parsed.uuid,
        parent_uuid: parsed.parentUuid,
        tool_use_id: parsed.toolUseId,
        tool_result_id: parsed.toolResultId,
        is_sidechain: parsed.isSidechain,
        stop_reason: parsed.stopReason,
        text_preview: parsed.textPreview,
        raw: parsed.raw,
        usage_in: parsed.usageIn,
        usage_out: parsed.usageOut,
        usage_cache_read: parsed.usageCacheRead,
        usage_cache_create: parsed.usageCacheCreate,
      };
      newEvents.push(ev);

      const sid = parsed.sessionId;
      if (!sid) continue;

      // Bootstrap session row from the first envelope we see for it.
      const projectPath = parsed.projectPath ?? projectPathFromSlug ?? "";
      const projectName = basename(projectPath || "(unknown)") || "(unknown)";
      stmts.upsertSessionStub.run(
        sid,
        projectPath,
        projectName,
        filePath,
        parsed.ts,
        parsed.ts,
        parsed.ts // state_since
      );
      touchedSessions.add(sid);

      // Side-effect rows we project at ingest time (cheap, no projection roundtrip).
      if (parsed.kind === "ai_title" && parsed.aiTitle) {
        stmts.setSessionTitle.run(parsed.aiTitle, sid);
      }

      if (parsed.kind === "permission_mode" && parsed.permissionMode) {
        // Latest write wins. permission_mode events lack a real ts, so within
        // a session they arrive in file order; the auto-increment id of the
        // event row preserves that order, and so does this UPDATE.
        stmts.setCurrentPermissionMode.run(parsed.permissionMode, sid);
      }

      // Roll up token usage on assistant events that carried message.usage.
      if (
        parsed.kind === "assistant_text" ||
        parsed.kind === "assistant_thinking" ||
        parsed.kind === "assistant_tool_use"
      ) {
        const inT = parsed.usageIn ?? 0;
        const outT = parsed.usageOut ?? 0;
        const crT = parsed.usageCacheRead ?? 0;
        const ccT = parsed.usageCacheCreate ?? 0;
        if (inT || outT || crT || ccT) {
          stmts.bumpSessionTokens.run(inT, outT, crT, ccT, sid);
        }
      }

      if (parsed.kind === "assistant_tool_use") {
        for (let i = 0; i < parsed.allToolUseIds.length; i++) {
          const tid = parsed.allToolUseIds[i];
          const tname = parsed.allToolNames[i] ?? parsed.toolName ?? "?";
          stmts.upsertToolStart.run(tid, sid, tname, parsed.ts, parsed.isSidechain);
        }
      }

      if (parsed.kind === "user_tool_result") {
        for (const tid of parsed.allToolResultIds) {
          // is_error not derivable here without re-parsing JSON; leave null
          // (the v2 UI doesn't depend on it for state, only for display).
          stmts.completeTool.run(parsed.ts, null, tid);
        }
      }
    }

    stmts.setOffset.run(filePath, tail.newOffset, tail.inode, tail.size, Date.now());
  });
  tx();

  return { newEvents, touchedSessions };
}

/**
 * Decode `~/.claude/projects/-Users-x-y/<sid>.jsonl` → "/Users/x/y" as a fallback
 * for sessions whose first envelope row didn't carry `cwd`.
 */
export function sessionFilePathToProjectPath(filePath: string): string {
  const m = filePath.match(/\.claude\/projects\/([^/]+)\//);
  if (!m) return "";
  return m[1]!.replaceAll("-", "/");
}
