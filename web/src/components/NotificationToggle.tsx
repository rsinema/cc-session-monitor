import { useEffect, useState } from "react";

/**
 * Tiny status + control for browser notifications, rendered in the sidebar
 * footer. Three states:
 *
 *   default   → "Enable notifications" button. Click triggers
 *               Notification.requestPermission() — Safari 16+ requires a
 *               user gesture, so we deliberately do NOT auto-request on
 *               page load.
 *   granted   → "🔔 on" with a click target that fires a test notification
 *               (helps users self-diagnose OS-level Do-Not-Disturb /
 *               browser-level mute).
 *   denied    → italic hint pointing at browser settings.
 *
 * On browsers without the Notification API (rare; mostly old WebViews),
 * renders nothing.
 */
export function NotificationToggle() {
  const supported = typeof window !== "undefined" && "Notification" in window;

  const [permission, setPermission] = useState<NotificationPermission | null>(
    supported ? Notification.permission : null
  );

  // The Permissions API can change underneath us if the user revokes/grants
  // from browser UI. Subscribe so the UI tracks reality.
  useEffect(() => {
    if (!supported || !("permissions" in navigator)) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: "notifications" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        const sync = () =>
          setPermission(status.state as NotificationPermission);
        sync();
        status.onchange = sync;
      })
      .catch(() => {
        // Some browsers (older Safari) don't expose notifications via
        // Permissions API — that's fine, our snapshot from constructor stays.
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  if (!supported || permission === null) return null;

  if (permission === "granted") {
    return (
      <button
        onClick={() => {
          new Notification("Claude Code", {
            body: "Test notification — you'll see these when sessions await input.",
            tag: "test",
          });
        }}
        title="Click to fire a test notification"
        className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        🔔 on
      </button>
    );
  }

  if (permission === "denied") {
    return (
      <span
        title="Re-enable in your browser's site settings for this page"
        className="text-[10px] text-zinc-600 italic cursor-help"
      >
        🔕 blocked
      </span>
    );
  }

  // permission === "default"
  return (
    <button
      onClick={async () => {
        try {
          const result = await Notification.requestPermission();
          setPermission(result);
        } catch {
          // Old Safari throws synchronously; fall back to callback form.
        }
      }}
      className="text-[10px] text-yellow-300 hover:text-yellow-200 transition-colors"
    >
      Enable notifications
    </button>
  );
}
