import { useMemo } from "react";
import type { Session } from "../api";
import { relativeTime } from "../lib/format";

interface Props {
  sessions: Session[];
  onPick: (id: string) => void;
}

const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export function Dashboard({ sessions, onPick }: Props) {
  const { awaiting, active, recent } = useMemo(() => {
    const now = Date.now();
    const awaiting: Session[] = [];
    const active: Session[] = [];
    const recent: Session[] = [];
    for (const s of sessions) {
      if (s.awaiting_input) awaiting.push(s);
      else if (now - s.last_activity <= ACTIVE_WINDOW_MS) active.push(s);
      else recent.push(s);
    }
    return { awaiting, active, recent };
  }, [sessions]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 py-6 max-w-6xl mx-auto space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-zinc-100">Session Status</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {awaiting.length > 0 ? (
              <span className="text-yellow-400 font-medium">
                {awaiting.length} session{awaiting.length === 1 ? "" : "s"} awaiting your input
              </span>
            ) : (
              <span>All clear — no sessions waiting on input.</span>
            )}
          </p>
        </header>

        {awaiting.length > 0 && (
          <Section title="Awaiting input" tone="awaiting">
            <CardGrid sessions={awaiting} onPick={onPick} tone="awaiting" />
          </Section>
        )}

        {active.length > 0 && (
          <Section
            title="Active"
            subtitle={`activity in the last ${Math.round(ACTIVE_WINDOW_MS / 60000)} min`}
            tone="active"
          >
            <CardGrid sessions={active} onPick={onPick} tone="active" />
          </Section>
        )}

        <Section title="Recent" subtitle={`${recent.length} session${recent.length === 1 ? "" : "s"}`}>
          {recent.length === 0 ? (
            <div className="text-zinc-500 text-sm">No older sessions.</div>
          ) : (
            <CardGrid sessions={recent} onPick={onPick} />
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  tone,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: "awaiting" | "active";
  children: React.ReactNode;
}) {
  const dot =
    tone === "awaiting"
      ? "bg-yellow-400 awaiting-pulse"
      : tone === "active"
      ? "bg-emerald-400"
      : "bg-zinc-700";
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className={`size-2 rounded-full ${dot}`} />
        <h2 className="text-sm uppercase tracking-wider text-zinc-300 font-medium">{title}</h2>
        {subtitle && <span className="text-xs text-zinc-600">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function CardGrid({
  sessions,
  onPick,
  tone,
}: {
  sessions: Session[];
  onPick: (id: string) => void;
  tone?: "awaiting" | "active";
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} onPick={onPick} tone={tone} />
      ))}
    </div>
  );
}

function SessionCard({
  session,
  onPick,
  tone,
}: {
  session: Session;
  onPick: (id: string) => void;
  tone?: "awaiting" | "active";
}) {
  const border =
    tone === "awaiting"
      ? "border-yellow-500/50 bg-yellow-500/5"
      : tone === "active"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : "border-zinc-800 bg-zinc-900/40";

  const preview = (session.latest_preview ?? "").trim();
  const previewTrimmed = preview.length > 240 ? preview.slice(0, 240) + "…" : preview;
  const roleLabel =
    session.latest_role === "assistant"
      ? "Claude"
      : session.latest_role === "user"
      ? "User"
      : null;

  return (
    <button
      onClick={() => onPick(session.id)}
      className={`text-left rounded-lg border ${border} p-4 hover:border-zinc-600 transition-colors group`}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-zinc-100 font-medium truncate">{session.project_name}</h3>
          {tone === "awaiting" && (
            <span className="text-[10px] uppercase tracking-wide text-yellow-400 font-semibold shrink-0">
              awaiting
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500 shrink-0">{relativeTime(session.last_activity)}</span>
      </div>
      <div className="text-xs text-zinc-600 font-mono truncate mb-2">
        {session.id.slice(0, 8)} · {session.message_count} msg
      </div>
      {previewTrimmed ? (
        <div className="text-xs text-zinc-400 line-clamp-3">
          {roleLabel && <span className="text-zinc-500 font-medium">{roleLabel}: </span>}
          {previewTrimmed}
        </div>
      ) : (
        <div className="text-xs text-zinc-600 italic">no messages yet</div>
      )}
    </button>
  );
}
