import { useEffect, useMemo, useState } from "react";
import type { Session } from "../api";
import { isStaleAwaiting } from "./Dashboard";
import { relativeTime } from "../lib/format";

interface Props {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const TRUNCATE_AT = 5;
const STORAGE_KEY = "sidebar.collapsed.v2";
const IDLE_AFTER_MS = 10 * 60 * 1000;

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** Effective "when did something meaningful last happen" — used for both
 *  ordering and the idle-vs-active heuristic. last_real_event_ts is the
 *  source of truth; fall back to last_event_ts only for legacy rows that
 *  predate the column. */
function effectiveTs(s: Session): number {
  return s.last_real_event_ts || s.last_event_ts;
}

function dotClassFor(s: Session): string {
  if (s.state === "AWAITING_USER") {
    return isStaleAwaiting(s) ? "bg-zinc-600" : "bg-yellow-400 awaiting-pulse";
  }
  if (s.state === "EXITED") return "bg-zinc-700";
  // WORKING
  if (Date.now() - effectiveTs(s) > IDLE_AFTER_MS) return "bg-zinc-600";
  return "bg-emerald-400";
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [expandedFully, setExpandedFully] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(collapsed)));
    } catch {}
  }, [collapsed]);

  const groups = useMemo(() => {
    const byProject = new Map<string, Session[]>();
    for (const s of sessions) {
      const key = s.project_name || "(unknown)";
      const list = byProject.get(key) ?? [];
      list.push(s);
      byProject.set(key, list);
    }
    for (const list of byProject.values()) {
      list.sort((a, b) => effectiveTs(b) - effectiveTs(a));
    }
    return Array.from(byProject.entries()).sort((a, b) => {
      const aLatest = Math.max(...a[1].map(effectiveTs));
      const bLatest = Math.max(...b[1].map(effectiveTs));
      return bLatest - aLatest;
    });
  }, [sessions]);

  function toggleCollapse(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleExpand(name: string) {
    setExpandedFully((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {groups.map(([projectName, list]) => {
        const containsSelected = selectedId != null && list.some((s) => s.id === selectedId);
        const isCollapsed = collapsed.has(projectName) && !containsSelected;
        const fullyExpanded = expandedFully.has(projectName) || containsSelected;
        const visible = isCollapsed
          ? []
          : fullyExpanded || list.length <= TRUNCATE_AT
          ? list
          : list.slice(0, TRUNCATE_AT);
        const hiddenCount = list.length - visible.length;

        return (
          <div key={projectName} className="mb-2">
            <button
              type="button"
              onClick={() => toggleCollapse(projectName)}
              className="w-full px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 sticky top-0 bg-zinc-950/95 backdrop-blur z-10 flex items-center gap-1.5 hover:text-zinc-300 transition-colors"
            >
              <span className="text-zinc-600 inline-block w-2.5 text-center">
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="truncate">{projectName}</span>
              <span className="ml-auto text-zinc-600 normal-case tracking-normal">
                {list.length}
              </span>
            </button>
            {visible.map((s) => {
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
                  <span
                    className={`mt-1.5 inline-block size-2 rounded-full shrink-0 ${dotClassFor(s)}`}
                    title={`${s.state}${s.sub_state ? ` · ${s.sub_state}` : ""}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={
                        "text-sm truncate " +
                        (s.title ? "text-zinc-200" : "text-zinc-200 font-mono")
                      }
                    >
                      {s.title?.trim() || s.id.slice(0, 8)}
                    </div>
                    <div className="text-xs text-zinc-500 flex justify-between gap-2">
                      <span>
                        {s.title ? <span className="font-mono text-zinc-600">{s.id.slice(0, 8)} · </span> : null}
                        {s.sub_state ?? s.state.toLowerCase()}
                      </span>
                      <span>{relativeTime(effectiveTs(s))}</span>
                    </div>
                  </div>
                </button>
              );
            })}
            {!isCollapsed && hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => toggleExpand(projectName)}
                className="w-full text-left px-3 py-1.5 pl-8 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40 transition-colors"
              >
                + {hiddenCount} more
              </button>
            )}
            {!isCollapsed && fullyExpanded && list.length > TRUNCATE_AT && !containsSelected && (
              <button
                type="button"
                onClick={() => toggleExpand(projectName)}
                className="w-full text-left px-3 py-1.5 pl-8 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40 transition-colors"
              >
                show fewer
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
