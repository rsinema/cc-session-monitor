/**
 * State projection — see plan §"Transition rules". This is the brain of v2.
 *
 * recomputeState(sessionId) applies the 6-step rule using the events table and
 * tool_invocations. Pure function of (events, tool_invocations, hook_perm_prompt_at)
 * — no side effects beyond the UPDATE to sessions.
 */
import { db, stmts, type SessionState, type SessionSubState, type EventRow } from "../db.ts";

export interface StateChange {
  sessionId: string;
  from: { state: SessionState; sub_state: SessionSubState } | null;
  to: { state: SessionState; sub_state: SessionSubState };
  toolUseId: string | null;
  exitedAtEvent: number | null;
  ts: number;
}

interface ProjectionInput {
  sessionId: string;
  latestEvent: EventRow | null;
  latestNonSidechainAssistant: EventRow | null;
  /**
   * Latest real user-driven event (user_text / user_tool_result / exit) for the
   * session, regardless of whether it's also the *overall* latest event. Used
   * by Rule 3 so the permission_prompt hook gets cleared as soon as the user
   * replies, even if the assistant has already streamed further events on top
   * of that reply.
   */
  latestRealUserEvent: EventRow | null;
  openTools: { tool_use_id: string; name: string; started_at: number; is_sidechain: number }[];
  hookPermPromptAt: number | null;
  exitedAtEvent: number | null;
  /** ts of the exit event itself; used to anchor state_since when EXITED. */
  exitedAtTs: number | null;
}

interface Projection {
  state: SessionState;
  sub_state: SessionSubState;
  current_tool_use_id: string | null;
  exited_at_event: number | null;
  /**
   * Timestamp of the event that drove the current state — the exit ts for
   * EXITED, the assistant turn ts for turn_complete, the tool's started_at for
   * tool_in_flight, etc. Persisted as sessions.state_since so the UI can
   * accurately tell how long the session has been in its current state,
   * independent of unrelated meta envelope rows that may have landed since.
   */
  state_since_ts: number;
}

/**
 * The 6-step rule. Pure. Exported for unit tests — feed it a ProjectionInput
 * and assert the Projection.
 */
export function project(input: ProjectionInput): Projection {
  const {
    latestEvent,
    latestNonSidechainAssistant,
    latestRealUserEvent,
    openTools,
    hookPermPromptAt,
    exitedAtEvent,
    exitedAtTs,
  } = input;

  // Rule 1: /exit + no later real event → EXITED
  // (exitedAtEvent is set by recomputeState only when no later real-user event
  // exists. The latestEvent might still be a system_meta or meta envelope,
  // which we deliberately ignore for exit shadowing.)
  if (exitedAtEvent != null) {
    return {
      state: "EXITED",
      sub_state: null,
      current_tool_use_id: null,
      exited_at_event: exitedAtEvent,
      state_since_ts: exitedAtTs ?? latestEvent?.ts ?? Date.now(),
    };
  }

  // Rule 2: any open tool_use → AWAITING_USER (blocking) or WORKING
  const nonSidechainOpen = openTools.filter((t) => !t.is_sidechain);
  const sidechainOpen = openTools.filter((t) => t.is_sidechain);

  for (const t of nonSidechainOpen) {
    if (t.name === "AskUserQuestion") {
      return {
        state: "AWAITING_USER",
        sub_state: "question",
        current_tool_use_id: t.tool_use_id,
        exited_at_event: null,
        state_since_ts: t.started_at,
      };
    }
    if (t.name === "ExitPlanMode") {
      return {
        state: "AWAITING_USER",
        sub_state: "plan_approval",
        current_tool_use_id: t.tool_use_id,
        exited_at_event: null,
        state_since_ts: t.started_at,
      };
    }
  }
  if (nonSidechainOpen.length > 0) {
    // Pick the most recently started tool to surface in UI.
    const t = [...nonSidechainOpen].sort((a, b) => b.started_at - a.started_at)[0]!;
    return {
      state: "WORKING",
      sub_state: "tool_in_flight",
      current_tool_use_id: t.tool_use_id,
      exited_at_event: null,
      state_since_ts: t.started_at,
    };
  }
  if (sidechainOpen.length > 0) {
    const t = [...sidechainOpen].sort((a, b) => b.started_at - a.started_at)[0]!;
    return {
      state: "WORKING",
      sub_state: "subagent_running",
      current_tool_use_id: t.tool_use_id,
      exited_at_event: null,
      state_since_ts: t.started_at,
    };
  }

  // Rule 3: hook permission prompt set, not yet cleared by a later real user event.
  //
  // We look at latestRealUserEvent — not latestEvent — because once the user
  // approves the prompt the assistant immediately streams more events on top
  // of the user_tool_result that cleared it. If we asked "is the *latest*
  // event a real user event?", the projection would correctly clear for one
  // tick and then snap back to permission_prompt as soon as an assistant_text
  // or assistant_tool_use lands.
  if (hookPermPromptAt != null) {
    const cleared =
      latestRealUserEvent != null &&
      latestRealUserEvent.ts >= hookPermPromptAt;
    if (!cleared) {
      return {
        state: "AWAITING_USER",
        sub_state: "permission_prompt",
        current_tool_use_id: null,
        exited_at_event: null,
        state_since_ts: hookPermPromptAt,
      };
    }
  }

  // Rule 4: latest non-sidechain assistant has stop_reason: end_turn
  if (
    latestNonSidechainAssistant &&
    latestNonSidechainAssistant.stop_reason === "end_turn"
  ) {
    // Make sure no real user reply landed AFTER it. Check latestRealUserEvent
    // (not latestEvent) for the same reason as Rule 3: a meta envelope landing
    // after the user reply must not undo our "the user is back" signal.
    //
    // Compare by (ts, id) — Claude Code can write several JSONL lines within
    // the same millisecond, so ts alone is ambiguous. The same lexicographic
    // ordering is what getLatestEvent uses to pick "the latest" event.
    const userReplyAfter =
      latestRealUserEvent != null &&
      (latestRealUserEvent.ts > latestNonSidechainAssistant.ts ||
        (latestRealUserEvent.ts === latestNonSidechainAssistant.ts &&
          latestRealUserEvent.id > latestNonSidechainAssistant.id));
    if (!userReplyAfter) {
      return {
        state: "AWAITING_USER",
        sub_state: "turn_complete",
        current_tool_use_id: null,
        exited_at_event: null,
        state_since_ts: latestNonSidechainAssistant.ts,
      };
    }
  }

  // Rule 5: latest event is a user prompt with no assistant response yet
  if (
    latestEvent &&
    (latestEvent.kind === "user_text" || latestEvent.kind === "user_tool_result")
  ) {
    return {
      state: "WORKING",
      sub_state: "streaming",
      current_tool_use_id: null,
      exited_at_event: null,
      state_since_ts: latestEvent.ts,
    };
  }

  // Rule 6: default → WORKING (catch-all; e.g. only meta events seen so far)
  return {
    state: "WORKING",
    sub_state: "streaming",
    current_tool_use_id: null,
    exited_at_event: null,
    state_since_ts: latestEvent?.ts ?? Date.now(),
  };
}

/**
 * Read the projection inputs for a session and apply them. Returns the new
 * Projection so callers can detect transitions and broadcast.
 */
export function recomputeState(sessionId: string): {
  before: Projection | null;
  after: Projection;
  changed: boolean;
  exitedAtEvent: number | null;
  ts: number;
} {
  const session = stmts.getSession.get(sessionId) as
    | {
        state: SessionState;
        sub_state: SessionSubState;
        current_tool_use_id: string | null;
        exited_at_event: number | null;
        hook_perm_prompt_at: number | null;
        last_event_ts: number;
      }
    | undefined;
  if (!session) {
    throw new Error(`recomputeState: session not found: ${sessionId}`);
  }

  const latestEvent = stmts.getLatestEvent.get(sessionId) as EventRow | undefined;
  const latestAsst = stmts.getLatestNonSidechainAssistant.get(sessionId) as
    | EventRow
    | undefined;
  const latestRealUser = stmts.getLatestRealUserEvent.get(sessionId) as
    | EventRow
    | undefined;
  const openTools = stmts.getOpenTools.all(sessionId) as {
    tool_use_id: string;
    name: string;
    started_at: number;
    is_sidechain: number;
  }[];

  // /exit detection: find the most recent exit event for this session, then
  // check whether anything strictly later (by ts/id) exists.
  const lastExit = db
    .query(
      `SELECT id, ts FROM events
        WHERE session_id = ? AND kind = 'exit'
        ORDER BY ts DESC, id DESC LIMIT 1`
    )
    .get(sessionId) as { id: number; ts: number } | undefined;
  let exitedAtEvent: number | null = null;
  if (lastExit) {
    const newer = db
      .query(
        `SELECT 1 FROM events
          WHERE session_id = ?
            AND kind IN ('user_text','user_tool_result','assistant_text','assistant_thinking','assistant_tool_use')
            AND (ts > ? OR (ts = ? AND id > ?))
          LIMIT 1`
      )
      .get(sessionId, lastExit.ts, lastExit.ts, lastExit.id);
    // Note: system_meta intentionally excluded — the goodbye-stdout that
    // immediately follows /exit shares the exit's timestamp and would otherwise
    // shadow it. permission_mode/ai_title are similarly excluded; they're
    // metadata, not "the user came back."
    if (!newer) exitedAtEvent = lastExit.id;
  }

  const proj = project({
    sessionId,
    latestEvent: latestEvent ?? null,
    latestNonSidechainAssistant: latestAsst ?? null,
    latestRealUserEvent: latestRealUser ?? null,
    openTools,
    hookPermPromptAt: session.hook_perm_prompt_at,
    exitedAtEvent,
    exitedAtTs: lastExit?.ts ?? null,
  });

  const before: Projection = {
    state: session.state,
    sub_state: session.sub_state,
    current_tool_use_id: session.current_tool_use_id,
    exited_at_event: session.exited_at_event,
    state_since_ts: 0, // unused for "before" comparison
  };
  const changed =
    before.state !== proj.state ||
    before.sub_state !== proj.sub_state ||
    before.current_tool_use_id !== proj.current_tool_use_id ||
    before.exited_at_event !== proj.exited_at_event;

  // Persist the state row whether or not the projection changed — state_since
  // can drift backward (e.g. once we recognize permission_mode noise was the
  // trailing event) and we still want it to settle correctly. Cheap: one
  // UPDATE per session per recompute.
  stmts.setSessionState.run(
    proj.state,
    proj.sub_state,
    proj.state_since_ts,
    proj.current_tool_use_id,
    proj.exited_at_event,
    sessionId
  );
  // Always bump last_event_ts to the latest event we know about (cheap).
  if (latestEvent) {
    stmts.bumpLastEventTs.run(latestEvent.ts, sessionId);
  }

  return {
    before,
    after: proj,
    changed,
    exitedAtEvent,
    ts: proj.state_since_ts,
  };
}

/**
 * Recompute every session's state. Used after backfill, and as the v2 equivalent
 * of v1's repair passes.
 */
export function recomputeAllStates(): number {
  const ids = db
    .query(`SELECT id FROM sessions ORDER BY last_event_ts ASC`)
    .all() as { id: string }[];
  let n = 0;
  for (const { id } of ids) {
    try {
      recomputeState(id);
      n++;
    } catch {
      // session row vanished mid-loop — skip
    }
  }
  return n;
}
