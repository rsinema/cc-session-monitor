import { useMemo } from "react";
import type { Session, SessionSubState } from "../api";
import { SUB_STATE_LABEL } from "../api";
import { relativeTime } from "../lib/format";

interface Props {
  sessions: Session[];
  onPick: (id: string) => void;
}

const WORKING_IDLE_AFTER_MS = 10 * 60 * 1000;
/**
 * `turn_complete` is *passively* awaiting — Claude said "done" and you may or
 * may not come back. Treat it as idle if it's older than this. The actively-
 * blocking sub-states (permission_prompt, plan_approval, question) are never
 * demoted: if Claude is blocked on a permission or a question, age doesn't
 * matter, the session needs attention.
 */
const TURN_COMPLETE_IDLE_AFTER_MS = 30 * 60 * 1000;

interface Bucket {
  key: string;
  title: string;
  subtitle?: string;
  tone: "awaiting" | "working" | "idle" | "exited";
  sessions: Session[];
}

const BLOCKING_SUB_STATES = new Set([
  "permission_prompt",
  "plan_approval",
  "question",
]);

/**
 * "Stale awaiting" = AWAITING_USER that doesn't actually demand attention right
 * now. Currently means a turn_complete older than TURN_COMPLETE_IDLE_AFTER_MS.
 * Exposed so SessionList and App can use the same definition for dot color and
 * the awaiting count badge.
 */
export function isStaleAwaiting(s: Session): boolean {
  if (s.state !== "AWAITING_USER") return false;
  if (s.sub_state && BLOCKING_SUB_STATES.has(s.sub_state)) return false;
  return Date.now() - s.state_since > TURN_COMPLETE_IDLE_AFTER_MS;
}

function bucket(s: Session): Bucket["tone"] {
  if (s.state === "EXITED") return "exited";
  if (s.state === "AWAITING_USER") {
    return isStaleAwaiting(s) ? "idle" : "awaiting";
  }
  // WORKING
  if (Date.now() - s.last_event_ts > WORKING_IDLE_AFTER_MS) return "idle";
  return "working";
}

const TONE_CLASS: Record<Bucket["tone"], string> = {
  awaiting: "bg-yellow-400 awaiting-pulse",
  working: "bg-emerald-400",
  idle: "bg-zinc-600",
  exited: "bg-zinc-800",
};

const TONE_BORDER: Record<Bucket["tone"], string> = {
  awaiting: "border-yellow-500/50 bg-yellow-500/5",
  working: "border-emerald-500/30 bg-emerald-500/5",
  idle: "border-zinc-800 bg-zinc-900/40",
  exited: "border-zinc-800 bg-zinc-900/30 opacity-70",
};

export function Dashboard({ sessions, onPick }: Props) {
  const buckets = useMemo<Bucket[]>(() => {
    const awaiting: Session[] = [];
    const working: Session[] = [];
    const idle: Session[] = [];
    const exited: Session[] = [];
    for (const s of sessions) {
      const t = bucket(s);
      if (t === "awaiting") awaiting.push(s);
      else if (t === "working") working.push(s);
      else if (t === "idle") idle.push(s);
      else exited.push(s);
    }
    return [
      { key: "awaiting", title: "Awaiting input", tone: "awaiting", sessions: awaiting },
      {
        key: "working",
        title: "Working",
        subtitle: `activity in the last ${Math.round(WORKING_IDLE_AFTER_MS / 60000)} min`,
        tone: "working",
        sessions: working,
      },
      { key: "idle", title: "Idle", tone: "idle", sessions: idle },
      { key: "exited", title: "Exited", tone: "exited", sessions: exited },
    ];
  }, [sessions]);

  const awaitingCount = buckets[0]!.sessions.length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 py-6 max-w-6xl mx-auto space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-zinc-100">Session Status</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {awaitingCount > 0 ? (
              <span className="text-yellow-400 font-medium">
                {awaitingCount} session{awaitingCount === 1 ? "" : "s"} awaiting your input
              </span>
            ) : (
              <span>All clear — no sessions waiting on input.</span>
            )}
          </p>
        </header>

        {buckets.map((b) =>
          b.sessions.length === 0 ? null : (
            <Section
              key={b.key}
              title={b.title}
              subtitle={
                b.subtitle ?? `${b.sessions.length} session${b.sessions.length === 1 ? "" : "s"}`
              }
              tone={b.tone}
            >
              <CardGrid sessions={b.sessions} onPick={onPick} tone={b.tone} />
            </Section>
          )
        )}
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
  tone: Bucket["tone"];
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className={`size-2 rounded-full ${TONE_CLASS[tone]}`} />
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
  tone: Bucket["tone"];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} onPick={onPick} tone={tone} />
      ))}
    </div>
  );
}

function SubStatePill({ sub }: { sub: SessionSubState }) {
  if (!sub) return null;
  const label = SUB_STATE_LABEL[sub];
  return (
    <span className="text-[10px] uppercase tracking-wide text-zinc-300 font-semibold shrink-0 px-1.5 py-0.5 rounded bg-zinc-800/70">
      {label}
    </span>
  );
}

function SessionCard({
  session,
  onPick,
  tone,
}: {
  session: Session;
  onPick: (id: string) => void;
  tone: Bucket["tone"];
}) {
  const heading = session.title?.trim() || session.project_name;
  const showSubtitle = !!session.title?.trim();

  return (
    <button
      onClick={() => onPick(session.id)}
      className={`text-left rounded-lg border ${TONE_BORDER[tone]} p-4 hover:border-zinc-600 transition-colors`}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-zinc-100 font-medium truncate">{heading}</h3>
          {tone === "awaiting" && (
            <span className="text-[10px] uppercase tracking-wide text-yellow-400 font-semibold shrink-0">
              awaiting
            </span>
          )}
          {tone === "exited" && (
            <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold shrink-0">
              exited
            </span>
          )}
          {tone === "idle" && (
            <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold shrink-0">
              idle
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500 shrink-0">{relativeTime(session.last_event_ts)}</span>
      </div>
      <div className="text-xs text-zinc-600 font-mono truncate mb-1 flex items-center gap-2">
        {showSubtitle && <span className="text-zinc-500">{session.project_name} ·</span>}
        <span>{session.id.slice(0, 8)}</span>
        <SubStatePill sub={session.sub_state} />
        <ModePill mode={session.current_permission_mode} />
        {session.current_tool_use_id && (
          <span className="text-blue-400">tool: {session.current_tool_use_id.slice(0, 10)}</span>
        )}
      </div>
      <TokenLine session={session} />
    </button>
  );
}

const MODE_LABEL: Record<string, string> = {
  auto: "auto",
  default: "default",
  acceptEdits: "accept edits",
  plan: "plan",
};
const MODE_TONE: Record<string, string> = {
  auto: "bg-purple-500/15 text-purple-300",
  acceptEdits: "bg-amber-500/15 text-amber-300",
  plan: "bg-sky-500/15 text-sky-300",
  default: "bg-zinc-700/40 text-zinc-300",
};

function ModePill({ mode }: { mode: string | null }) {
  if (!mode) return null;
  const label = MODE_LABEL[mode] ?? mode;
  const tone = MODE_TONE[mode] ?? MODE_TONE.default;
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-semibold shrink-0 px-1.5 py-0.5 rounded ${tone}`}
      title={`permission mode: ${mode}`}
    >
      {label}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function TokenLine({ session }: { session: Session }) {
  const total = session.tokens_in + session.tokens_out;
  if (total === 0) return null;
  return (
    <div className="text-[11px] font-mono text-zinc-500 truncate">
      <span className="text-zinc-600">↑</span>{" "}
      <span className="text-zinc-300">{formatTokens(session.tokens_in)}</span>
      <span className="text-zinc-700"> · </span>
      <span className="text-zinc-600">↓</span>{" "}
      <span className="text-zinc-300">{formatTokens(session.tokens_out)}</span>
      {session.tokens_cache_read > 0 && (
        <>
          <span className="text-zinc-700"> · </span>
          <span className="text-zinc-600">cache</span>{" "}
          <span className="text-zinc-400">{formatTokens(session.tokens_cache_read)}</span>
        </>
      )}
    </div>
  );
}
