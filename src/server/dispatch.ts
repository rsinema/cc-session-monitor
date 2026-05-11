/**
 * Glue between ingest results and the SSE bus. Given a list of new events,
 * recompute affected sessions' state and broadcast everything that changed.
 */
import { stmts, type EventRow, type SessionRow } from "../db.ts";
import { recomputeState } from "../state/project.ts";
import { publish } from "./sse.ts";
import { macNotify } from "./notify.ts";
import { notifyAwaitingWebhooks } from "./webhooks.ts";

export interface DispatchInput {
  newEvents: EventRow[];
  touchedSessions: Set<string>;
}

/**
 * Process the result of an ingest pass:
 *   1. Broadcast `event_appended` for each new event.
 *   2. Emit `tool_started` / `tool_completed` for tool_use / tool_result events.
 *   3. Recompute state for every touched session; emit `state_changed` and
 *      `session_meta` if anything changed.
 *   4. Fire macOS notifications on transitions into AWAITING_USER (any sub_state).
 */
export function dispatch({ newEvents, touchedSessions }: DispatchInput) {
  for (const ev of newEvents) {
    publish({ type: "event_appended", sessionId: ev.session_id ?? "", event: ev });

    if (ev.kind === "assistant_tool_use" && ev.tool_use_id) {
      publish({
        type: "tool_started",
        sessionId: ev.session_id ?? "",
        toolUseId: ev.tool_use_id,
        name: "?", // could be fanned out via tool_invocations; keep slim for SSE
        ts: ev.ts,
      });
    }
    if (ev.kind === "user_tool_result" && ev.tool_result_id) {
      publish({
        type: "tool_completed",
        sessionId: ev.session_id ?? "",
        toolUseId: ev.tool_result_id,
        ts: ev.ts,
      });
    }
  }

  for (const sid of touchedSessions) {
    let recomputed: ReturnType<typeof recomputeState>;
    try {
      recomputed = recomputeState(sid);
    } catch {
      continue;
    }
    const session = stmts.getSession.get(sid) as SessionRow | undefined;
    if (!session) continue;
    publish({ type: "session_meta", session });

    if (recomputed.changed) {
      publish({
        type: "state_changed",
        sessionId: sid,
        from: recomputed.before
          ? { state: recomputed.before.state, sub_state: recomputed.before.sub_state }
          : null,
        to: { state: recomputed.after.state, sub_state: recomputed.after.sub_state },
        currentToolUseId: recomputed.after.current_tool_use_id,
        ts: recomputed.ts,
      });

      const enteredAwaiting =
        recomputed.after.state === "AWAITING_USER" &&
        (!recomputed.before || recomputed.before.state !== "AWAITING_USER");
      if (enteredAwaiting) {
        const sub = recomputed.after.sub_state ?? "input";
        macNotify("Claude Code", `${session.project_name}: ${sub.replaceAll("_", " ")}`);
        notifyAwaitingWebhooks({ session, subState: sub });
      }
    }
  }
}
