import { useQuery } from "@tanstack/react-query";
import { api, type SearchResult } from "../api";
import { relativeTime } from "../lib/format";

interface Props {
  query: string;
  onPick: (sessionId: string) => void;
}

export function SearchResults({ query, onPick }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search(query),
    enabled: query.trim().length > 0,
  });

  if (!query.trim()) return null;
  if (isLoading) return <div className="p-8 text-zinc-500">Searching…</div>;
  if (error) return <div className="p-8 text-red-400">Error: {String(error)}</div>;
  const results = data ?? [];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="border-b border-zinc-800 px-6 py-3">
        <div className="text-sm text-zinc-300">
          {results.length} result{results.length === 1 ? "" : "s"} for{" "}
          <span className="font-mono text-yellow-400">{query}</span>
        </div>
      </div>
      <div className="px-3 py-2 space-y-1">
        {results.map((r: SearchResult) => (
          <button
            key={r.id}
            onClick={() => onPick(r.session_id)}
            className="w-full text-left rounded px-3 py-2 hover:bg-zinc-900 transition-colors"
          >
            <div className="flex justify-between items-baseline gap-2 text-xs text-zinc-500 mb-1">
              <span>
                {r.project_name}{" "}
                <span className="text-zinc-600">·</span>{" "}
                <span className="text-zinc-600">{r.role}</span>
              </span>
              <span>{relativeTime(r.timestamp)}</span>
            </div>
            <div
              className="text-sm text-zinc-200 break-words"
              dangerouslySetInnerHTML={{ __html: r.snippet }}
            />
          </button>
        ))}
        {results.length === 0 && (
          <div className="text-zinc-500 text-sm px-3 py-2">No matches.</div>
        )}
      </div>
    </div>
  );
}
