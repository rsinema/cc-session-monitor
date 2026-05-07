import { spawn } from "node:child_process";
import { stmts } from "./db.ts";
import { publish } from "./bus.ts";

/**
 * Handle a Claude Code hook payload (POSTed by ~/.claude-monitor/hooks/notify.sh).
 *
 * We care about:
 *  - `Notification`  → set awaiting_input=1, fire macOS notification, broadcast.
 *  - `Stop`          → set awaiting_input=0, broadcast.
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

  if (event === "Stop" || event === "SubagentStop") {
    if (sessionId) {
      stmts.setAwaitingInput.run(0, sessionId);
      const session = stmts.getSessionById.get(sessionId);
      if (session) publish({ type: "session_updated", session });
      publish({ type: "awaiting_input", sessionId, awaitingInput: false });
    }
    return { ok: true, handled: event };
  }

  return { ok: true, handled: null };
}

function macNotify(title: string, body: string) {
  const safeTitle = String(title).slice(0, 200).replace(/"/g, '\\"');
  const safeBody = String(body).slice(0, 400).replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}" sound name "Glass"`;
  try {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Best effort — never throw out of a hook handler.
  }
}
