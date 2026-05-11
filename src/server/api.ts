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
    const includeArchived = c.req.query("include_archived") === "true";
    const sessions = includeArchived
      ? stmts.listSessionsIncludingArchived.all(limit, offset)
      : stmts.listSessions.all(limit, offset);
    const archivedCount = (stmts.countArchived.get() as { c: number }).c;
    return c.json({ sessions, archivedCount });
  });

  app.post("/api/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    if (!stmts.getSession.get(id)) return c.json({ error: "not found" }, 404);
    stmts.setArchivedAt.run(Date.now(), id);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/unarchive", (c) => {
    const id = c.req.param("id");
    if (!stmts.getSession.get(id)) return c.json({ error: "not found" }, 404);
    stmts.setArchivedAt.run(null, id);
    return c.json({ ok: true });
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

  app.get("/api/insights", (c) => {
    const range = (c.req.query("range") ?? "7d").toLowerCase();
    const now = Date.now();
    const RANGE_MS: Record<string, number> = {
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };
    const isAll = range === "all";
    const fromTs = isAll ? 0 : now - (RANGE_MS[range] ?? RANGE_MS["7d"]!);
    const toTs = now;

    // Token rollup. Pulled from assistant events because that's where usage
    // is recorded; sessions.tokens_* is the all-time total, which doesn't
    // respect the range filter.
    const tokensRow = db
      .query(
        `SELECT
           COALESCE(SUM(usage_in), 0) AS tokens_in,
           COALESCE(SUM(usage_out), 0) AS tokens_out,
           COALESCE(SUM(usage_cache_read), 0) AS tokens_cache_read,
           COALESCE(SUM(usage_cache_create), 0) AS tokens_cache_create
         FROM events
         WHERE kind IN ('assistant_text','assistant_thinking','assistant_tool_use')
           AND ts >= ? AND ts <= ?`
      )
      .get(fromTs, toTs) as {
      tokens_in: number;
      tokens_out: number;
      tokens_cache_read: number;
      tokens_cache_create: number;
    };

    // Filter out the '?' placeholder rows that completeToolUpsert inserts
    // when a tool_result lands before its tool_use; those get their real
    // name once the tool_use line is ingested, but the GROUP BY shouldn't
    // surface them in the meantime.
    const topTools = db
      .query(
        `SELECT
           name,
           COUNT(*) AS count,
           COALESCE(SUM(
             CASE
               WHEN completed_at IS NOT NULL THEN completed_at - started_at
               ELSE 0
             END
           ), 0) AS total_ms
         FROM tool_invocations
         WHERE name != '?'
           AND started_at >= ? AND started_at <= ?
         GROUP BY name
         ORDER BY count DESC
         LIMIT 15`
      )
      .all(fromTs, toTs);

    const sessionCount = (
      db
        .query(
          `SELECT COUNT(DISTINCT session_id) AS c FROM events
            WHERE ts >= ? AND ts <= ? AND session_id IS NOT NULL`
        )
        .get(fromTs, toTs) as { c: number }
    ).c;

    const eventCount = (
      db
        .query(
          `SELECT COUNT(*) AS c FROM events
            WHERE ts >= ? AND ts <= ?
              AND kind IN ('user_text','user_tool_result','assistant_text','assistant_thinking','assistant_tool_use')`
        )
        .get(fromTs, toTs) as { c: number }
    ).c;

    const byProject = db
      .query(
        `SELECT
           s.project_name AS project,
           COUNT(DISTINCT e.session_id) AS sessions,
           COALESCE(SUM(e.usage_in), 0) AS tokens_in,
           COALESCE(SUM(e.usage_out), 0) AS tokens_out
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.ts >= ? AND e.ts <= ?
           AND e.kind IN ('assistant_text','assistant_thinking','assistant_tool_use')
         GROUP BY s.project_name
         ORDER BY (tokens_in + tokens_out) DESC
         LIMIT 10`
      )
      .all(fromTs, toTs);

    return c.json({
      range: isAll ? "all" : range,
      fromTs,
      toTs,
      sessionCount,
      eventCount,
      tokens: tokensRow,
      topTools,
      byProject,
    });
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
