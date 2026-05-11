import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type InsightsRange } from "../api";

const RANGES: { value: InsightsRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

function formatNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function Insights() {
  const [range, setRange] = useState<InsightsRange>("7d");
  const { data, isLoading } = useQuery({
    queryKey: ["insights", range],
    queryFn: () => api.getInsights(range),
    refetchInterval: 60_000,
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 py-6 max-w-6xl mx-auto space-y-8">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-100">Insights</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Token usage and tool activity over the selected window.
            </p>
          </div>
          <div className="flex gap-1 rounded border border-zinc-800 p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={
                  "px-3 py-1 text-xs rounded transition-colors " +
                  (range === r.value
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800")
                }
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>

        {isLoading && <div className="text-sm text-zinc-500">Loading…</div>}

        {data && (
          <>
            <section>
              <h2 className="text-sm uppercase tracking-wider text-zinc-300 font-medium mb-3">
                Overview
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="Sessions touched" value={formatNum(data.sessionCount)} />
                <Stat label="Real events" value={formatNum(data.eventCount)} />
                <Stat label="Input tokens" value={formatNum(data.tokens.tokens_in)} />
                <Stat label="Output tokens" value={formatNum(data.tokens.tokens_out)} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                <Stat label="Cache read" value={formatNum(data.tokens.tokens_cache_read)} muted />
                <Stat
                  label="Cache create"
                  value={formatNum(data.tokens.tokens_cache_create)}
                  muted
                />
              </div>
            </section>

            <section>
              <h2 className="text-sm uppercase tracking-wider text-zinc-300 font-medium mb-3">
                Top tools
              </h2>
              {data.topTools.length === 0 ? (
                <div className="text-sm text-zinc-600">No tool calls in this window.</div>
              ) : (
                <Bars
                  rows={data.topTools.map((t) => ({
                    label: t.name,
                    primary: t.count,
                    secondary: t.total_ms > 0 ? formatMs(t.total_ms) : null,
                    primaryLabel: `${t.count} call${t.count === 1 ? "" : "s"}`,
                  }))}
                />
              )}
            </section>

            <section>
              <h2 className="text-sm uppercase tracking-wider text-zinc-300 font-medium mb-3">
                Tokens by project
              </h2>
              {data.byProject.length === 0 ? (
                <div className="text-sm text-zinc-600">No usage in this window.</div>
              ) : (
                <Bars
                  rows={data.byProject.map((p) => {
                    const total = p.tokens_in + p.tokens_out;
                    return {
                      label: p.project,
                      primary: total,
                      secondary: `${p.sessions} session${p.sessions === 1 ? "" : "s"}`,
                      primaryLabel: `${formatNum(total)} tok`,
                    };
                  })}
                />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={"rounded-lg border border-zinc-800 p-4 " + (muted ? "opacity-70" : "")}>
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-xl font-semibold text-zinc-100 mt-1 font-mono">{value}</div>
    </div>
  );
}

function Bars({
  rows,
}: {
  rows: { label: string; primary: number; primaryLabel: string; secondary: string | null }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.primary));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const pct = Math.max(2, Math.round((r.primary / max) * 100));
        return (
          <div key={r.label} className="grid grid-cols-[160px_1fr_auto] items-center gap-3 text-sm">
            <div className="text-zinc-300 truncate font-mono text-xs" title={r.label}>
              {r.label}
            </div>
            <div className="h-5 bg-zinc-900 rounded overflow-hidden border border-zinc-800">
              <div
                className="h-full bg-emerald-500/30"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-xs text-zinc-400 font-mono whitespace-nowrap">
              {r.primaryLabel}
              {r.secondary && <span className="text-zinc-600"> · {r.secondary}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
