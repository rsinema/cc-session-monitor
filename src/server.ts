import { Hono } from "hono";
import { stream } from "hono/streaming";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { db, stmts } from "./db.ts";
import { ingestFile } from "./ingest.ts";
import { startWatcher } from "./watcher.ts";
import { subscribeBus, publish } from "./bus.ts";
import { handleHookEvent } from "./hooks.ts";
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
  const messages = stmts.getMessagesBySession.all(id);
  return c.json({ session, messages });
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
startWatcher(PROJECTS_DIR, (filePath) => {
  try {
    const { newEvents, touchedSessions } = ingestFile(filePath);
    for (const id of touchedSessions) {
      const session = stmts.getSessionById.get(id);
      if (session) publish({ type: "session_updated", session });
    }
    for (const evt of newEvents) {
      publish({ type: "message", sessionId: evt.sessionId, message: evt });
    }
  } catch (err) {
    console.error("ingest error:", err);
  }
});

console.log(`[claude-monitor] listening on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
  // Keep SSE connections open longer than the default.
  idleTimeout: 240,
};
