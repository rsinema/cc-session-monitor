import { Hono } from "hono";
import { stream } from "hono/streaming";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { db, stmts } from "./db.ts";
import { ingestFile } from "./ingest.ts";
import { startWatcher } from "./watcher.ts";
import { subscribeBus, publish } from "./bus.ts";
import { handleHookEvent } from "./hooks.ts";
import {
  rebuildAwaitingFromMessages,
  clearStaleAwaiting,
  backfillExitedAt,
  backfillTitles,
  inferAwaitingFromIdle,
} from "./repair.ts";
import { fileURLToPath } from "node:url";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PORT = Number(process.env.PORT ?? 3737);

const app = new Hono();

// ── API ────────────────────────────────────────────────────────────────
app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/sessions", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);
  const rows = stmts.listSessions.all(limit, offset);
  return c.json({ sessions: rows });
});

app.get("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = stmts.getSessionById.get(id);
  if (!session) return c.json({ error: "not found" }, 404);

  const limitParam = c.req.query("limit");
  const total = (stmts.countMessagesInSession.get(id) as { c: number }).c;
  const messages = limitParam
    ? stmts.getLatestMessages.all(id, Math.min(Number(limitParam) || 10, 1000))
    : stmts.getMessagesBySession.all(id);

  return c.json({ session, messages, total });
});

/** Load earlier messages strictly before a given timestamp (cursor pagination). */
app.get("/api/sessions/:id/messages", (c) => {
  const id = c.req.param("id");
  const beforeTs = Number(c.req.query("before_ts") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  if (!beforeTs) return c.json({ error: "before_ts required" }, 400);
  const messages = stmts.getMessagesBefore.all(id, beforeTs, limit);
  return c.json({ messages });
});

app.get("/api/search", (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ results: [] });
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  // FTS5 syntax: quote untrusted input to prevent operator misuse.
  const escaped = `"${q.replaceAll('"', '""')}"`;
  let results: unknown[] = [];
  try {
    results = stmts.searchMessages.all(escaped, limit);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
  return c.json({ results });
});

// ── Hook callback ──────────────────────────────────────────────────────
app.post("/api/hook/notify", async (c) => {
  let body: any = null;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const result = handleHookEvent(body);
  return c.json(result);
});

// ── SSE live stream ────────────────────────────────────────────────────
app.get("/api/stream", (c) => {
  return stream(c, async (s) => {
    s.onAbort(() => {
      unsubscribe?.();
    });
    // Tell Hono to keep the connection open as SSE.
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    let unsubscribe: (() => void) | null = null;
    await s.writeln(": connected");

    unsubscribe = subscribeBus((evt) => {
      const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
      s.write(payload).catch(() => {
        unsubscribe?.();
      });
    });

    // Heartbeat every 25s so proxies don't drop us.
    const interval = setInterval(() => {
      s.writeln(": heartbeat").catch(() => clearInterval(interval));
    }, 25_000);

    // Hold the stream open.
    await new Promise<void>((resolve) => {
      s.onAbort(() => {
        clearInterval(interval);
        unsubscribe?.();
        resolve();
      });
    });
  });
});

// ── Static frontend ────────────────────────────────────────────────────
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

app.get("*", async (c) => {
  const url = new URL(c.req.url);
  let p = url.pathname;
  if (p === "/" || !p.includes(".")) p = "/index.html";
  const filePath = join(distDir, p);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // Fallback to index.html for client-side routes.
    const indexPath = join(distDir, "index.html");
    if (!existsSync(indexPath)) {
      return c.text(
        "Frontend not built yet. Run `bun run build` or `bun run dev` (which starts Vite).",
        404
      );
    }
    return c.body(readFileSync(indexPath), 200, { "Content-Type": "text/html" });
  }
  const ext = p.slice(p.lastIndexOf("."));
  const ct =
    ext === ".html"
      ? "text/html"
      : ext === ".js"
      ? "text/javascript"
      : ext === ".css"
      ? "text/css"
      : ext === ".svg"
      ? "image/svg+xml"
      : ext === ".json"
      ? "application/json"
      : "application/octet-stream";
  return c.body(readFileSync(filePath), 200, { "Content-Type": ct });
});

// ── Boot ───────────────────────────────────────────────────────────────
function ingestAndPublish(filePath: string) {
  const { newEvents, touchedSessions } = ingestFile(filePath);
  for (const id of touchedSessions) {
    const session = stmts.getSessionById.get(id);
    if (session) publish({ type: "session_updated", session });
  }
  for (const evt of newEvents) {
    publish({ type: "message", sessionId: evt.sessionId, message: evt });
  }
  return { newEvents, touchedSessions };
}

// Walk every JSONL under rootDir and run `onFile`. Used at boot (closes the
// gap between watcher's `ignoreInitial: true` and reality) AND on the periodic
// timer (safety net for chokidar drops — fsevents misses or `awaitWriteFinish`
// starvation during bursty writes). `ingestFile` is idempotent on line offsets,
// so re-running is cheap.
//
// `lastMtime` is an in-memory cache of `mtimeMs` per path. When provided, files
// whose mtime hasn't advanced since the previous walk are skipped without
// reading — turning the steady-state sweep into pure stat (~1ms for ~100 files).
// Pass `undefined` to force-read everything (used at boot to handle changes
// that landed while the server was down).
function walkJsonl(
  rootDir: string,
  onFile: (filePath: string) => void,
  lastMtime?: Map<string, number>
) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(full);
      } else if (s.isFile() && full.endsWith(".jsonl")) {
        if (lastMtime) {
          const prev = lastMtime.get(full);
          if (prev !== undefined && prev >= s.mtimeMs) continue;
          lastMtime.set(full, s.mtimeMs);
        }
        try {
          onFile(full);
        } catch (err) {
          console.error("[walk] failed", full, err);
        }
      }
    }
  }
}

// Boot catchup: ingest everything, count files with new content for logging.
let bootChanged = 0;
walkJsonl(PROJECTS_DIR, (filePath) => {
  const { newEvents, touchedSessions } = ingestFile(filePath);
  if (newEvents.length || touchedSessions.size) bootChanged++;
});
if (bootChanged > 0) console.log(`[catchup] ingested updates for ${bootChanged} files`);

// Reconcile state with the actual message stream:
//  - awaiting: flip on for sessions with an open blocking tool_use we haven't tracked yet
//  - awaiting: flip on when the last message is idle assistant text (Stop hook missed)
//  - awaiting: flip off for sessions whose last message is already a user reply
//  - exited:   stamp exited_at from historical /exit commands the ingest path missed
//  - titles:   stamp title from ai-title rows that ingest skipped past
const flipped = rebuildAwaitingFromMessages();
const inferred = inferAwaitingFromIdle();
const cleared = clearStaleAwaiting();
const exited = backfillExitedAt();
const titled = backfillTitles();
if (flipped.size > 0 || inferred.size > 0 || cleared.size > 0 || exited.size > 0 || titled.size > 0) {
  console.log(
    `[repair] awaiting: +${flipped.size}+${inferred.size}/-${cleared.size}; exited: +${exited.size}; titles: +${titled.size}`
  );
  for (const id of new Set([...flipped, ...inferred, ...cleared, ...exited, ...titled])) {
    const session = stmts.getSessionById.get(id);
    if (session) publish({ type: "session_updated", session });
  }
}

startWatcher(PROJECTS_DIR, (filePath) => {
  try {
    ingestAndPublish(filePath);
  } catch (err) {
    console.error("ingest error:", err);
  }
});

// Periodic safety-net sweep: chokidar can miss change events on macOS
// (fsevents drops or `awaitWriteFinish` starvation during bursty writes).
// Re-walk every 2s and ingest anything new — idempotent via line offsets.
// The mtime cache keeps the typical tick to a stat-only walk (~1ms), so the
// short interval costs <0.1% CPU even with ~100 session files.
// Also re-runs `clearStaleAwaiting` so a Notification-hook-set flag that the
// user has since answered (via tool_result with a NULL recorded id, etc.)
// gets cleared even if the watcher fell behind.
const PERIODIC_INTERVAL_MS = 2_000;
const sweepMtime = new Map<string, number>();
setInterval(() => {
  try {
    walkJsonl(PROJECTS_DIR, ingestAndPublish, sweepMtime);
    const stale = clearStaleAwaiting();
    // Self-heal when a Stop hook didn't reach us (e.g. server was reloading).
    // The 5s idle threshold avoids flicker mid-turn.
    const inferredNow = inferAwaitingFromIdle();
    for (const id of new Set([...stale, ...inferredNow])) {
      const session = stmts.getSessionById.get(id);
      if (session) publish({ type: "session_updated", session });
    }
  } catch (err) {
    console.error("[periodic] sweep failed:", err);
  }
}, PERIODIC_INTERVAL_MS);

console.log(`[claude-monitor] listening on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
  // Keep SSE connections open longer than the default.
  idleTimeout: 240,
};
