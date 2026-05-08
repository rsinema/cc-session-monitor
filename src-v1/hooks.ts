import { stmts } from "./db.ts";
import { publish } from "./bus.ts";
import { macNotify } from "./notify.ts";

/**
 * Handle a Claude Code hook payload (POSTed by ~/.claude-monitor/hooks/notify.sh).
 *
 * Semantics:
 *  - `Notification`  → in-turn alert (permission prompt, AskUserQuestion).
 *                      awaiting=1, macNotify, broadcast.
 *  - `Stop`          → assistant turn ended; user is now needed for the next
 *                      message. awaiting=1, macNotify, broadcast.
 *  - `SubagentStop`  → a subagent (Task tool) finished. The parent session is
 *                      still running, so DO NOT flip awaiting; just acknowledge.
 *
 * Other hook events are accepted but no-op (so registering more hooks is safe).
 */
export function handleHookEvent(body: any): { ok: boolean; handled: string | null } {
  if (!body || typeof body !== "object") return { ok: true, handled: null };

  // Claude Code hook schemas have varied across versions; accept several field names.
  const event: string | undefined =
    body.hook_event_name ?? body.hookEventName ?? body.event ?? body.eventName;
  const sessionId: string | undefined =
    body.session_id ?? body.sessionId ?? body.session?.id;
  const message: string | undefined = body.message ?? body.notification ?? body.title;

  if (!event) return { ok: true, handled: null };

  if (event === "Notification") {
    if (sessionId) {
      stmts.setAwaitingInput.run(1, sessionId);
      const session = stmts.getSessionById.get(sessionId);
      if (session) publish({ type: "session_updated", session });
      publish({ type: "awaiting_input", sessionId, awaitingInput: true });
    }
    macNotify("Claude Code", message ?? "Awaiting your input");
    return { ok: true, handled: "Notification" };
  }

  if (event === "Stop") {
    if (sessionId) {
      stmts.setAwaitingInput.run(1, sessionId);
      const session = stmts.getSessionById.get(sessionId) as any;
      if (session) publish({ type: "session_updated", session });
      publish({ type: "awaiting_input", sessionId, awaitingInput: true });
      const projectName = session?.project_name;
      macNotify("Claude Code", projectName ? `${projectName}: turn complete` : "Turn complete");
    }
    return { ok: true, handled: "Stop" };
  }

  if (event === "SubagentStop") {
    // Subagent finished but the parent session is still running. No state change.
    return { ok: true, handled: "SubagentStop" };
  }

  return { ok: true, handled: null };
}

