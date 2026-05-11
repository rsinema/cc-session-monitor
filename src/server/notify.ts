import { spawn } from "node:child_process";

/**
 * Fire a macOS Notification Center banner via osascript. Best-effort.
 *
 * No-op on non-darwin platforms: when the server runs inside a Linux Docker
 * container there's no host-bridge for osascript anyway, and previously
 * `spawn("osascript", …)` here would emit an async ENOENT error event that
 * the surrounding try/catch could not catch — crashing the process.
 *
 * Browser notifications (web/src/hooks/useLiveUpdates.ts) are the supported
 * channel for Docker-hosted deployments.
 */
export function macNotify(title: string, body: string) {
  if (process.platform !== "darwin") return;

  const safeTitle = String(title).slice(0, 200).replace(/"/g, '\\"');
  const safeBody = String(body).slice(0, 400).replace(/"/g, '\\"');
  const script = `display notification "${safeBody}" with title "${safeTitle}" sound name "Glass"`;
  try {
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    // Async ENOENT (e.g. osascript missing from PATH even on darwin) is
    // delivered as an 'error' event; without a listener Node would crash.
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore synchronous spawn failures too
  }
}
