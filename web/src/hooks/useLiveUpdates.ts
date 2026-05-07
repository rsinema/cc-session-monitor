import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Message, Session } from "../api";

/**
 * Connect to /api/stream once and merge events into TanStack Query caches.
 * The transcript query key is `["session", id, limit]`; for live appends we touch every
 * cached limit-window for that session id.
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
          const row = normalizeMessage(m, evt.sessionId);

          // Append to all cached transcript windows for this session.
          const caches = qc.getQueryCache().findAll({ queryKey: ["session", evt.sessionId] });
          for (const cache of caches) {
            qc.setQueryData<{ session: Session; messages: Message[]; total?: number } | undefined>(
              cache.queryKey,
              (prev) => {
                if (!prev) return prev;
                if (prev.messages.some((x) => x.id === row.id)) return prev;
                return {
                  ...prev,
                  messages: [...prev.messages, row],
                  total: (prev.total ?? prev.messages.length) + 1,
                };
              }
            );
          }
        } else if (evt.type === "session_updated") {
          const s = evt.session as Session;
          qc.setQueryData<Session[] | undefined>(["sessions"], (prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((x) => x.id === s.id);
            if (idx === -1) return [s, ...prev];
            // Preserve any latest_preview fields the new payload doesn't include.
            const merged = { ...prev[idx], ...s } as Session;
            const next = [...prev];
            next[idx] = merged;
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

function normalizeMessage(m: any, sessionId: string): Message {
  return {
    id: m.id,
    session_id: m.sessionId ?? m.session_id ?? sessionId,
    parent_id: m.parentId ?? m.parent_id ?? null,
    role: m.role,
    type: m.type,
    content: m.content,
    text_preview: m.textPreview ?? m.text_preview ?? null,
    timestamp: m.timestamp,
    line_number: m.line_number ?? 0,
  };
}
