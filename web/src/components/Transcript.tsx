import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { MessageView } from "./Message";
import { relativeTime } from "../lib/format";

interface Props {
  sessionId: string;
}

export function Transcript({ sessionId }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

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

  const { session, messages } = data;

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-zinc-800 px-6 py-3 bg-zinc-950/80 backdrop-blur">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-medium truncate">{session.project_name}</h2>
            <div className="text-xs text-zinc-500 truncate font-mono">{session.project_path}</div>
          </div>
          <div className="text-xs text-zinc-500 text-right shrink-0">
            <div>{messages.length} messages</div>
            <div>active {relativeTime(session.last_activity)}</div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
