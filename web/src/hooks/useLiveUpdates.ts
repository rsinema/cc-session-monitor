import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Message, Session } from "../api";

/**
 * Connect to /api/stream once. Merge incoming events into TanStack Query caches:
 *  - "message"          → append into the open session's message list (if cached)
 *  - "session_updated"  → upsert into the sessions list
 *  - "awaiting_input"   → fire a browser notification when the page is in the background
 */
export function useLiveUpdates() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/stream");

    function onMessage(ev: MessageEvent<string>) {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === "message") {
          const m = evt.message as Message;
          qc.setQueryData<{ session: Session; messages: Message[] } | undefined>(
            ["session", evt.sessionId],
            (prev) => {
              if (!prev) return prev;
              if (prev.messages.some((x) => x.id === m.id)) return prev;
              // Backend ParsedEvent uses camelCase; normalize to row shape used by API.
              const row: Message = {
                id: m.id,
                session_id: (m as any).sessionId ?? evt.sessionId,
                parent_id: (m as any).parentId ?? (m as any).parent_id ?? null,
                role: (m as any).role,
                type: (m as any).type,
                content: (m as any).content,
                text_preview: (m as any).textPreview ?? (m as any).text_preview ?? null,
                timestamp: (m as any).timestamp,
                line_number: (m as any).line_number ?? 0,
              };
              return { ...prev, messages: [...prev.messages, row] };
            }
          );
        } else if (evt.type === "session_updated") {
          const s = evt.session as Session;
          qc.setQueryData<Session[] | undefined>(["sessions"], (prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((x) => x.id === s.id);
            if (idx === -1) return [s, ...prev];
            const next = [...prev];
            next[idx] = s;
            // Re-sort by last_activity DESC.
            next.sort((a, b) => b.last_activity - a.last_activity);
            return next;
          });
        } else if (evt.type === "awaiting_input") {
          if (evt.awaitingInput && document.hidden && "Notification" in window) {
            if (Notification.permission === "granted") {
              new Notification("Claude Code", { body: "Awaiting your input" });
            }
          }
        }
      } catch {
        // ignore malformed
      }
    }

    es.addEventListener("message", onMessage);
    es.addEventListener("session_updated", onMessage);
    es.addEventListener("awaiting_input", onMessage);

    return () => {
      es.close();
    };
  }, [qc]);
}
