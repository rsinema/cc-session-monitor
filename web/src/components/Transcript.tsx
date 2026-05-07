import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Message } from "../api";
import { MessageView } from "./Message";
import { relativeTime } from "../lib/format";

interface Props {
  sessionId: string;
  onBack?: () => void;
}

const INITIAL_LIMIT = 10;
const PAGE_SIZE = 30;

export function Transcript({ sessionId, onBack }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["session", sessionId, INITIAL_LIMIT],
    queryFn: () => api.getSession(sessionId, { limit: INITIAL_LIMIT }),
  });

  const [earlier, setEarlier] = useState<Message[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  // Reset earlier-window when switching sessions.
  useEffect(() => {
    setEarlier([]);
    lastCount.current = 0;
  }, [sessionId]);

  useEffect(() => {
    const count = data?.messages.length ?? 0;
    if (count > lastCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    lastCount.current = count;
  }, [data?.messages.length]);

  if (isLoading) return <div className="p-8 text-zinc-500">Loading…</div>;
  if (error) return <div className="p-8 text-red-400">Error: {String(error)}</div>;
  if (!data) return null;

  const { session, messages, total = messages.length } = data;
  const hasMoreEarlier = earlier.length + messages.length < total;
  const earlierShown = earlier.length;
  const remaining = Math.max(0, total - messages.length - earlierShown);

  async function loadEarlier() {
    if (loadingEarlier) return;
    const oldest = earlier[0]?.timestamp ?? messages[0]?.timestamp;
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const more = await api.getEarlierMessages(sessionId, oldest, PAGE_SIZE);
      setEarlier((prev) => [...more, ...prev]);
    } finally {
      setLoadingEarlier(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-zinc-800 px-6 py-3 bg-zinc-950/80 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {onBack && (
              <button
                onClick={onBack}
                className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded border border-zinc-800 hover:border-zinc-600 shrink-0"
              >
                ← Overview
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-medium truncate">
                {session.project_name}
                {session.awaiting_input ? (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-yellow-400 font-semibold">
                    awaiting
                  </span>
                ) : null}
              </h2>
              <div className="text-xs text-zinc-500 truncate font-mono">{session.project_path}</div>
            </div>
          </div>
          <div className="text-xs text-zinc-500 text-right shrink-0">
            <div>{total} messages</div>
            <div>active {relativeTime(session.last_activity)}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {hasMoreEarlier ? (
          <div className="text-center">
            <button
              onClick={loadEarlier}
              disabled={loadingEarlier}
              className="text-xs text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded border border-zinc-800 hover:border-zinc-600 disabled:opacity-50"
            >
              {loadingEarlier
                ? "Loading…"
                : `↑ Show earlier (${remaining} more)`}
            </button>
          </div>
        ) : total > messages.length + earlierShown ? null : earlierShown > 0 || messages.length < total ? (
          <div className="text-center text-[11px] text-zinc-600">— start of session —</div>
        ) : null}

        {earlier.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
