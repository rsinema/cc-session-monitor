import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, SessionEvent } from "../api";

/**
 * Connect once to /api/stream and merge SSE events into the TanStack Query
 * caches. v2 vocabulary:
 *   - event_appended  → push into transcript caches
 *   - state_changed   → refresh sessions list (fields baked into session_meta)
 *   - tool_started    → bump tool spinner cache
 *   - tool_completed  → resolve tool spinner cache
 *   - session_meta    → upsert session row
 */
export function useLiveUpdates() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/stream");

    function handle(ev: MessageEvent<string>) {
      let evt: any;
      try {
        evt = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (evt.type === "event_appended") {
        const row = evt.event as SessionEvent;
        const caches = qc
          .getQueryCache()
          .findAll({ queryKey: ["session", evt.sessionId] });
        for (const cache of caches) {
          qc.setQueryData<
            | {
                session: Session;
                events: SessionEvent[];
                total: number;
                openTools: any[];
              }
            | undefined
          >(cache.queryKey, (prev) => {
            if (!prev) return prev;
            if (prev.events.some((x) => x.id === row.id)) return prev;
            return {
              ...prev,
              events: [...prev.events, row],
              total: (prev.total ?? prev.events.length) + 1,
            };
          });
        }
      } else if (evt.type === "session_meta") {
        const s = evt.session as Session;
        qc.setQueryData<Session[] | undefined>(["sessions"], (prev) => {
          if (!prev) return prev;
          const idx = prev.findIndex((x) => x.id === s.id);
          if (idx === -1) return [s, ...prev];
          const next = [...prev];
          next[idx] = { ...next[idx], ...s };
          next.sort((a, b) => b.last_event_ts - a.last_event_ts);
          return next;
        });
      } else if (evt.type === "state_changed") {
        // Browser ping when entering AWAITING_USER and the page is hidden.
        if (
          evt.to?.state === "AWAITING_USER" &&
          document.hidden &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          new Notification("Claude Code", {
            body: `${evt.to.sub_state ?? "input needed"}`,
          });
        }
      }
      // tool_started / tool_completed are surfaced via session_meta refresh.
    }

    es.addEventListener("event_appended", handle);
    es.addEventListener("state_changed", handle);
    es.addEventListener("tool_started", handle);
    es.addEventListener("tool_completed", handle);
    es.addEventListener("session_meta", handle);

    return () => {
      es.close();
    };
  }, [qc]);
}
