/**
 * Claude Code hook payloads → events table + state recompute.
 *
 * v1 had a separate awaiting-flag column that the Notification/Stop hooks
 * mutated directly. v2 records the hook firing as an event row (so it shows
 * up in transcripts and the state machine sees it via the same pipeline as
 * everything else) and then triggers a recompute.
 */
import { db, stmts, type EventRow } from "../db.ts";
import { recomputeState } from "./project.ts";
import { createHash } from "node:crypto";

export interface HookResult {
  ok: boolean;
  handled: string | null;
  sessionId: string | null;
  /** New event row inserted by this hook payload, if any. */
  event?: EventRow;
  /** Touched session ids — caller should dispatch SSE updates for these. */
  touchedSessions?: Set<string>;
}

const HOOK_SYNTH_FILE = "<<hook>>";

/**
 * Claude Code's Notification hook fires for two unrelated reasons:
 *   1. Permission ask — body.message = "Claude needs your permission to use <tool>"
 *   2. Idle timeout (default 60s) or generic "needs your attention"
 *
 * Only #1 should park the session in `permission_prompt`. The idle variant
 * was previously conflated, which flipped completed sessions back to
 * "Permission" forever (hook ts always beats the user's older reply ts).
 *
 * Match the literal phrase "needs your permission" — it's stable across
 * tool names ("Bash", "Edit", etc.) and unique to the permission path.
 */
export function isPermissionMessage(msg: string | null | undefined): boolean {
  if (typeof msg !== "string") return false;
  return /needs your permission/i.test(msg);
}

export function ingestHookEvent(body: any): HookResult {
  if (!body || typeof body !== "object") {
    return { ok: true, handled: null, sessionId: null };
  }

  const event: string | undefined =
    body.hook_event_name ?? body.hookEventName ?? body.event ?? body.eventName;
  const sessionId: string | undefined =
    body.session_id ?? body.sessionId ?? body.session?.id;

  if (!event || !sessionId) {
    return { ok: true, handled: null, sessionId: sessionId ?? null };
  }

  const ts = Date.now();
  const lineSha = createHash("sha1")
    .update(`hook|${event}|${sessionId}|${ts}|${JSON.stringify(body)}`)
    .digest("hex");
  const raw = JSON.stringify(body);

  const kind =
    event === "Notification"
      ? "hook_notification"
      : event === "Stop"
      ? "hook_stop"
      : event === "SubagentStop"
      ? "hook_subagent_stop"
      : null;
  if (!kind) {
    return { ok: true, handled: null, sessionId };
  }

  // Synthetic byte_offset = ts for hook rows so the (file_path, byte_offset)
  // UNIQUE constraint can't conflict with real JSONL rows; line_sha provides
  // content-level dedupe in case the same hook payload arrives twice.
  let inserted: EventRow | null = null;
  const tx = db.transaction(() => {
    const ret = stmts.insertEvent.get(
      HOOK_SYNTH_FILE,
      ts,
      lineSha,
      sessionId,
      kind,
      ts,
      null, // uuid
      null, // parent_uuid
      null, // tool_use_id
      null, // tool_result_id
      0, // is_sidechain
      null, // stop_reason
      typeof body.message === "string" ? body.message : null,
      raw,
      null, // usage_in
      null, // usage_out
      null, // usage_cache_read
      null // usage_cache_create
    ) as { id: number } | undefined;
    if (!ret) return;
    inserted = {
      id: ret.id,
      file_path: HOOK_SYNTH_FILE,
      byte_offset: ts,
      line_sha: lineSha,
      session_id: sessionId,
      kind,
      ts,
      uuid: null,
      parent_uuid: null,
      tool_use_id: null,
      tool_result_id: null,
      is_sidechain: 0,
      stop_reason: null,
      text_preview: typeof body.message === "string" ? body.message : null,
      raw,
      usage_in: null,
      usage_out: null,
      usage_cache_read: null,
      usage_cache_create: null,
    };
    if (kind === "hook_notification") {
      if (isPermissionMessage(body.message)) {
        stmts.setHookPermPromptAt.run(ts, sessionId);
      } else {
        // Idle / generic-attention notification. Claude isn't blocked on a
        // permission ask; any previous permission flag is stale by definition
        // (the assistant clearly continued past it to reach the idle state),
        // so clear it. This also self-heals stuck sessions over time.
        stmts.setHookPermPromptAt.run(null, sessionId);
      }
    }
  });
  tx();

  if (!inserted) {
    return { ok: true, handled: kind, sessionId };
  }

  const touched = new Set<string>();
  // SubagentStop is informational only.
  if (kind !== "hook_subagent_stop") {
    try {
      recomputeState(sessionId);
      touched.add(sessionId);
    } catch {
      // Session row may not exist yet — next ingestFile will create it and
      // recompute. The hook event is already persisted.
    }
  }

  return { ok: true, handled: kind, sessionId, event: inserted, touchedSessions: touched };
}
