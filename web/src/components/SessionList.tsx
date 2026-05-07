import type { Session } from "../api";
import { relativeTime } from "../lib/format";

interface Props {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  // Group by project_name.
  const byProject = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.project_name || "(unknown)";
    const list = byProject.get(key) ?? [];
    list.push(s);
    byProject.set(key, list);
  }
  const groups = Array.from(byProject.entries()).sort((a, b) => {
    const aLatest = Math.max(...a[1].map((s) => s.last_activity));
    const bLatest = Math.max(...b[1].map((s) => s.last_activity));
    return bLatest - aLatest;
  });

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {groups.map(([projectName, list]) => (
        <div key={projectName} className="mb-2">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 sticky top-0 bg-zinc-950/95 backdrop-blur z-10">
            {projectName}
            <span className="ml-2 text-zinc-600 normal-case tracking-normal">{list.length}</span>
          </div>
          {list.map((s) => {
            const isActive = s.id === selectedId;
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={
                  "w-full text-left px-3 py-2 border-l-2 flex items-start gap-2 transition-colors " +
                  (isActive
                    ? "bg-zinc-800/60 border-blue-500"
                    : "border-transparent hover:bg-zinc-900/60")
                }
              >
                {s.awaiting_input ? (
                  <span
                    className="awaiting-pulse mt-1.5 inline-block size-2 rounded-full bg-yellow-400 shrink-0"
                    title="Awaiting input"
                  />
                ) : (
                  <span className="mt-1.5 inline-block size-2 rounded-full bg-zinc-700 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-200 truncate font-mono">{shortId(s.id)}</div>
                  <div className="text-xs text-zinc-500 flex justify-between gap-2">
                    <span>{s.message_count} msg</span>
                    <span>{relativeTime(s.last_activity)}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function shortId(id: string) {
  return id.slice(0, 8);
}
