/**
 * Outbound webhooks for "session entered AWAITING_USER". Configured via env
 * vars so docker-compose deployments can wire this up without a UI:
 *
 *   SLACK_WEBHOOK_URL     incoming-webhook URL from a Slack app
 *   DISCORD_WEBHOOK_URL   from channel settings → Integrations → Webhooks
 *   NTFY_WEBHOOK_URL      a fully-qualified topic URL (e.g. https://ntfy.sh/my-topic)
 *   MONITOR_PUBLIC_URL    optional, used to build a clickable link in the body
 *
 * Each fires only on the entered-awaiting transition (same trigger as the
 * macOS notify path in dispatch.ts) and is fire-and-forget — a slow or down
 * webhook target must never block the ingest pipeline.
 */
import type { SessionRow } from "../db.ts";

const WEBHOOK_TIMEOUT_MS = 5_000;

interface Targets {
  slack: string | null;
  discord: string | null;
  ntfy: string | null;
  publicUrl: string | null;
}

function readTargets(): Targets {
  return {
    slack: process.env.SLACK_WEBHOOK_URL || null,
    discord: process.env.DISCORD_WEBHOOK_URL || null,
    ntfy: process.env.NTFY_WEBHOOK_URL || null,
    publicUrl: process.env.MONITOR_PUBLIC_URL || null,
  };
}

export interface AwaitingPayload {
  session: SessionRow;
  subState: string;
}

/**
 * Format a single human-readable line that's safe to drop into Slack /
 * Discord / ntfy / etc. without per-platform markup. Each adapter wraps this
 * in its own envelope.
 */
export function formatAwaitingMessage(p: AwaitingPayload, publicUrl: string | null): string {
  const project = p.session.project_name || "session";
  const sub = p.subState.replaceAll("_", " ");
  const title = p.session.title?.trim();
  const head = title ? `${project} — ${title}` : project;
  const link = publicUrl ? ` ${publicUrl.replace(/\/$/, "")}/#/session/${p.session.id}` : "";
  return `${head} · ${sub}${link}`;
}

async function post(url: string, body: unknown, contentType = "application/json"): Promise<void> {
  const ctrl = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  const init: RequestInit = {
    method: "POST",
    signal: ctrl,
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`webhook ${url} responded ${res.status}`);
  }
}

async function sendSlack(url: string, message: string): Promise<void> {
  await post(url, { text: message });
}

async function sendDiscord(url: string, message: string): Promise<void> {
  await post(url, { content: message });
}

async function sendNtfy(url: string, message: string): Promise<void> {
  await post(url, message, "text/plain");
}

/**
 * Fire all configured webhooks in parallel. Returns immediately; failures
 * are logged but never thrown. Safe to call from the ingest dispatch path.
 */
export function notifyAwaitingWebhooks(p: AwaitingPayload): void {
  const t = readTargets();
  if (!t.slack && !t.discord && !t.ntfy) return;
  const msg = formatAwaitingMessage(p, t.publicUrl);

  const fires: Array<Promise<void>> = [];
  if (t.slack) fires.push(sendSlack(t.slack, msg).catch((err) => logFail("slack", err)));
  if (t.discord) fires.push(sendDiscord(t.discord, msg).catch((err) => logFail("discord", err)));
  if (t.ntfy) fires.push(sendNtfy(t.ntfy, msg).catch((err) => logFail("ntfy", err)));

  // Detach from the caller — no awaiting. Any future rejections are already
  // swallowed by the per-target `.catch`, so an unhandled rejection from
  // these promises can't crash the process either.
  Promise.allSettled(fires);
}

function logFail(target: string, err: unknown) {
  console.error(`[webhook:${target}] failed:`, err);
}
