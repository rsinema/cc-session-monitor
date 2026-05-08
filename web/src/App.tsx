import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { SessionList } from "./components/SessionList";
import { Transcript } from "./components/Transcript";
import { Dashboard, isStaleAwaiting } from "./components/Dashboard";
import { SearchBar } from "./components/SearchBar";
import { SearchResults } from "./components/SearchResults";
import { useLiveUpdates } from "./hooks/useLiveUpdates";

type View = { kind: "dashboard" } | { kind: "session"; id: string };

export default function App() {
  useLiveUpdates();

  const [view, setView] = useState<View>({ kind: "dashboard" });
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: api.listSessions,
    refetchInterval: 30_000,
  });

  // Notification permission, requested once on first load.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // ⌘K / Ctrl+K to focus search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && view.kind === "session") {
        setView({ kind: "dashboard" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.kind]);

  function pickSession(id: string) {
    setView({ kind: "session", id });
    setQuery("");
  }

  const awaitingCount = sessions.filter(
    (s) => s.state === "AWAITING_USER" && !isStaleAwaiting(s)
  ).length;
  const selectedId = view.kind === "session" ? view.id : null;

  return (
    <div className="h-full grid grid-cols-[280px_1fr] bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="border-r border-zinc-800 flex flex-col min-h-0">
        <div className="p-3 border-b border-zinc-800 space-y-2">
          <button
            onClick={() => setView({ kind: "dashboard" })}
            className={
              "w-full text-left px-3 py-2 rounded text-sm flex items-center justify-between gap-2 transition-colors " +
              (view.kind === "dashboard"
                ? "bg-zinc-800/60 text-zinc-100"
                : "hover:bg-zinc-900/60 text-zinc-300")
            }
          >
            <span className="flex items-center gap-2">
              <span className="text-zinc-500">▦</span> Overview
            </span>
            {awaitingCount > 0 && (
              <span className="text-[10px] uppercase tracking-wide bg-yellow-500/20 text-yellow-300 rounded px-1.5 py-0.5 font-semibold">
                {awaitingCount}
              </span>
            )}
          </button>
          <SearchBar
            ref={searchRef}
            value={query}
            onChange={setQuery}
            onClear={() => setQuery("")}
          />
        </div>
        <div className="flex-1 min-h-0">
          <SessionList sessions={sessions} selectedId={selectedId} onSelect={pickSession} />
        </div>
        <div className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-600 flex justify-between">
          <span>{sessions.length} sessions</span>
          <span>v0.2</span>
        </div>
      </aside>

      {/* Main */}
      <main className="min-w-0">
        {query.trim() ? (
          <SearchResults query={query} onPick={pickSession} />
        ) : view.kind === "session" ? (
          <Transcript
            sessionId={view.id}
            onBack={() => setView({ kind: "dashboard" })}
          />
        ) : (
          <Dashboard sessions={sessions} onPick={pickSession} />
        )}
      </main>
    </div>
  );
}
