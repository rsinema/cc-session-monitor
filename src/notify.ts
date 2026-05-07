import { spawn } from "node:child_process";

/**
 * Fire a macOS Notification Center banner via osascript. Best-effort —
 * never throws, so callers can fire-and-forget.
 */
export function macNotify(title: string, body: string) {
  const safeTitle = String(title).slice(0, 200).replace(/"/g, '\\"');
  const safeBody = String(body).slice(0, 400).replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}" sound name "Glass"`;
  try {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // ignore
  }
}
