import { Hono } from "hono";
import { stream } from "hono/streaming";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, stmts } from "../db.ts";
import { ingestHookEvent } from "../state/hooks.ts";
import { dispatch } from "./dispatch.ts";
import { subscribeBus } from "./sse.ts";

export function createApp() {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/sessions", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
    const offset = Number(c.req.query("offset") ?? 0);
    const sessions = stmts.listSessions.all(limit, offset);
    return c.json({ sessions });
  });

  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = stmts.getSession.get(id);
    if (!session) return c.json({ error: "not found" }, 404);

    const limitParam = c.req.query("limit");
    const totalRow = stmts.countEventsForSession.get(id) as { c: number };
    const total = totalRow.c;

    let events: unknown[];
    if (limitParam) {
      const lim = Math.min(Number(limitParam) || 30, 1000);
      events = db
        .query(
          `SELECT * FROM (
             SELECT * FROM events
              WHERE session_id = ?
              ORDER BY ts DESC, id DESC
              LIMIT ?
           ) ORDER BY ts ASC, id ASC`
        )
        .all(id, lim);
    } else {
      events = stmts.getEventsForSession.all(id);
    }

    const openTools = stmts.getOpenTools.all(id);
    return c.json({ session, events, total, openTools });
  });

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const beforeTs = Number(c.req.query("before_ts") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
    if (!beforeTs) return c.json({ error: "before_ts required" }, 400);
    const events = db
      .query(
        `SELECT * FROM (
           SELECT * FROM events
            WHERE session_id = ? AND ts < ?
            ORDER BY ts DESC, id DESC
            LIMIT ?
         ) ORDER BY ts ASC, id ASC`
      )
      .all(id, beforeTs, limit);
    return c.json({ events });
  });

  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ results: [] });
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const escaped = `"${q.replaceAll('"', '""')}"`;
    let results: unknown[] = [];
    try {
      results = stmts.searchEvents.all(escaped, limit);
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    return c.json({ results });
  });

  app.post("/api/hook/notify", async (c) => {
    let body: any = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const r = ingestHookEvent(body);
    if (r.event && r.touchedSessions) {
      dispatch({ newEvents: [r.event], touchedSessions: r.touchedSessions });
    }
    return c.json({ ok: r.ok, handled: r.handled, sessionId: r.sessionId });
  });

  app.get("/api/stream", (c) => {
    return stream(c, async (s) => {
      let unsubscribe: (() => void) | null = null;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
      };

      s.onAbort(close);
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");
      await s.writeln(": connected");

      unsubscribe = subscribeBus((evt) => {
        const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
        s.write(payload).catch(() => close());
      });

      const interval = setInterval(() => {
        s.writeln(": heartbeat").catch(() => clearInterval(interval));
      }, 25_000);

      await new Promise<void>((resolve) => {
        s.onAbort(() => {
          clearInterval(interval);
          close();
          resolve();
        });
      });
    });
  });

  return app;
}

export function attachStaticFrontend(app: Hono) {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  app.get("*", (c) => {
    const url = new URL(c.req.url);
    let p = url.pathname;
    if (p === "/" || !p.includes(".")) p = "/index.html";
    const filePath = join(distDir, p);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      const indexPath = join(distDir, "index.html");
      if (!existsSync(indexPath)) {
        return c.text(
          "Frontend not built yet. Run `bun run build` or `bun run dev`.",
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
}
