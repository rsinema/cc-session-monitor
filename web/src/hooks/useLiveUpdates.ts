import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ListSessionsResult, Session, SessionEvent } from "../api";

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
        // listSessions is keyed by includeArchived now, so walk every matching
        // cache. A session that just received an event should auto-unarchive
        // (the server clears archived_at in bumpLastRealEventTs), so we keep
        // it in the showArchived=false cache too.
        const caches = qc.getQueryCache().findAll({ queryKey: ["sessions"] });
        for (const cache of caches) {
          qc.setQueryData<ListSessionsResult | undefined>(cache.queryKey, (prev) => {
            if (!prev) return prev;
            const idx = prev.sessions.findIndex((x) => x.id === s.id);
            let nextList: Session[];
            if (idx === -1) {
              nextList = [s, ...prev.sessions];
            } else {
              nextList = [...prev.sessions];
              nextList[idx] = { ...nextList[idx], ...s };
            }
            nextList.sort(
              (a, b) =>
                (b.last_real_event_ts || b.last_event_ts) -
                (a.last_real_event_ts || a.last_event_ts)
            );
            return { ...prev, sessions: nextList };
          });
        }
      } else if (evt.type === "state_changed") {
        // Ping when a session newly enters AWAITING_USER and the user isn't
        // looking at this dashboard. We use !document.hasFocus() rather than
        // document.hidden because the typical workflow is "dashboard tab
        // visible in a background window, terminal in front" — that's
        // hidden=false, hasFocus()=false, which is exactly when we want to
        // ping. document.hidden would suppress the notification.
        const enteredAwaiting =
          evt.to?.state === "AWAITING_USER" &&
          (!evt.from || evt.from.state !== "AWAITING_USER");
        if (
          enteredAwaiting &&
          !document.hasFocus() &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          // Look up the session for context (project name). Walk every
          // sessions cache key — the active one might be the showArchived=true
          // variant depending on the user's toggle state.
          const caches = qc.getQueryCache().findAll({ queryKey: ["sessions"] });
          let session: Session | undefined;
          for (const cache of caches) {
            const data = qc.getQueryData<ListSessionsResult>(cache.queryKey);
            const hit = data?.sessions.find((s) => s.id === evt.sessionId);
            if (hit) {
              session = hit;
              break;
            }
          }
          const project = session?.project_name ?? "Claude Code";
          const sub = (evt.to.sub_state ?? "input needed").replaceAll("_", " ");
          const n = new Notification(project, {
            body: sub,
            // Dedupe: rapid sub_state churn within AWAITING_USER reuses the
            // existing notification rather than stacking up.
            tag: `awaiting:${evt.sessionId}`,
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
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
