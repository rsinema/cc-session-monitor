import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { SessionList } from "./components/SessionList";
import { Transcript } from "./components/Transcript";
import { SearchBar } from "./components/SearchBar";
import { SearchResults } from "./components/SearchResults";
import { useLiveUpdates } from "./hooks/useLiveUpdates";

export default function App() {
  useLiveUpdates();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: api.listSessions,
  });

  // Pick the most recent session by default.
  useEffect(() => {
    if (!selectedId && sessions.length > 0) setSelectedId(sessions[0].id);
  }, [selectedId, sessions]);

  // Request notification permission once.
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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-full grid grid-cols-[320px_1fr] bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="border-r border-zinc-800 flex flex-col min-h-0">
        <div className="p-3 border-b border-zinc-800">
          <SearchBar
            ref={searchRef}
            value={query}
            onChange={setQuery}
            onClear={() => setQuery("")}
          />
        </div>
        <div className="flex-1 min-h-0">
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setQuery("");
            }}
          />
        </div>
        <div className="border-t border-zinc-800 px-3 py-2 text-[11px] text-zinc-600 flex justify-between">
          <span>{sessions.length} sessions</span>
          <span>v0.1</span>
        </div>
      </aside>

      {/* Main */}
      <main className="min-w-0">
        {query.trim() ? (
          <SearchResults
            query={query}
            onPick={(id) => {
              setSelectedId(id);
              setQuery("");
            }}
          />
        ) : selectedId ? (
          <Transcript sessionId={selectedId} />
        ) : (
          <div className="h-full flex items-center justify-center text-zinc-500">
            Select a session
          </div>
        )}
      </main>
    </div>
  );
}
