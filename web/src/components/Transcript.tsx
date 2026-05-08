import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SessionEvent, SUB_STATE_LABEL } from "../api";
import { EventView } from "./Message";
import { relativeTime } from "../lib/format";

interface Props {
  sessionId: string;
  onBack?: () => void;
}

const INITIAL_LIMIT = 30;
const PAGE_SIZE = 50;

export function Transcript({ sessionId, onBack }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["session", sessionId, INITIAL_LIMIT],
    queryFn: () => api.getSession(sessionId, { limit: INITIAL_LIMIT }),
  });

  const [earlier, setEarlier] = useState<SessionEvent[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  useEffect(() => {
    setEarlier([]);
    lastCount.current = 0;
  }, [sessionId]);

  useEffect(() => {
    const count = data?.events.length ?? 0;
    if (count > lastCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    lastCount.current = count;
  }, [data?.events.length]);

  if (isLoading) return <div className="p-8 text-zinc-500">Loading…</div>;
  if (error) return <div className="p-8 text-red-400">Error: {String(error)}</div>;
  if (!data) return null;

  const { session, events, total } = data;
  const hasMoreEarlier = earlier.length + events.length < total;
  const remaining = Math.max(0, total - events.length - earlier.length);

  async function loadEarlier() {
    if (loadingEarlier) return;
    const oldest = earlier[0]?.ts ?? events[0]?.ts;
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const more = await api.getEarlierEvents(sessionId, oldest, PAGE_SIZE);
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
              <h2 className="text-lg font-medium truncate flex items-center gap-2">
                {session.title?.trim() || session.project_name}
                <StatePill session={session} />
              </h2>
              <div className="text-xs text-zinc-500 truncate font-mono">
                {session.title?.trim() ? `${session.project_name} · ` : ""}
                {session.project_path}
              </div>
            </div>
          </div>
          <div className="text-xs text-zinc-500 text-right shrink-0">
            <div>{total} events</div>
            <div>active {relativeTime(session.last_event_ts)}</div>
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
              {loadingEarlier ? "Loading…" : `↑ Show earlier (${remaining} more)`}
            </button>
          </div>
        ) : earlier.length > 0 || events.length > 0 ? (
          <div className="text-center text-[11px] text-zinc-600">— start of session —</div>
        ) : null}

        {earlier.map((e) => (
          <EventView key={e.id} event={e} />
        ))}
        {events.map((e) => (
          <EventView key={e.id} event={e} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function StatePill({ session }: { session: { state: string; sub_state: string | null } }) {
  const tone =
    session.state === "AWAITING_USER"
      ? "bg-yellow-500/20 text-yellow-300"
      : session.state === "EXITED"
      ? "bg-zinc-800 text-zinc-400"
      : "bg-emerald-500/20 text-emerald-300";
  const label =
    session.sub_state && session.sub_state in SUB_STATE_LABEL
      ? (SUB_STATE_LABEL as Record<string, string>)[session.sub_state]
      : session.state.toLowerCase().replaceAll("_", " ");
  return (
    <span className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${tone}`}>
      {label}
    </span>
  );
}
