import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { stmts, DB_FILE } from "./db.ts";
import { ingestFile } from "./reader/ingest.ts";
import { startWatcher } from "./reader/watcher.ts";
import { recomputeAllStates } from "./state/project.ts";
import { runMigrations } from "./migrations.ts";
import { createApp, attachStaticFrontend } from "./server/api.ts";
import { dispatch } from "./server/dispatch.ts";
import { ARCHIVE_AFTER_MS, archiveStaleSessions } from "./archiver.ts";

const PROJECTS_DIR =
  process.env.CC_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const PORT = Number(process.env.PORT ?? 3737);

console.log(`[claude-monitor v2] DB: ${DB_FILE}`);

// Boot catchup: walk every JSONL once on startup. Idempotent via byte offsets.
function walkJsonl(rootDir: string, onFile: (path: string) => void) {
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
      if (s.isDirectory()) stack.push(full);
      else if (s.isFile() && full.endsWith(".jsonl")) {
        try {
          onFile(full);
        } catch (err) {
          console.error("[boot] failed", full, err);
        }
      }
    }
  }
}

const bootStart = Date.now();
let bootEvents = 0;
walkJsonl(PROJECTS_DIR, (filePath) => {
  const r = ingestFile(filePath);
  bootEvents += r.newEvents.length;
});
for (const m of runMigrations()) {
  if (m.ran) console.log(`[migration] ${m.key}: ${m.details ?? "done"}`);
}
const projected = recomputeAllStates();
const archived = archiveStaleSessions();
console.log(
  `[boot] ingested ${bootEvents} new events; projected ${projected} sessions; archived ${archived} stale in ${
    Date.now() - bootStart
  }ms`
);

// Re-run hourly. New events for an archived session auto-unarchive via
// bumpLastRealEventTs, so the steady state stays accurate without a per-event
// archive check.
if (ARCHIVE_AFTER_MS > 0) {
  setInterval(() => {
    try {
      const n = archiveStaleSessions();
      if (n > 0) console.log(`[archiver] archived ${n} sessions`);
    } catch (err) {
      console.error("[archiver] failed:", err);
    }
  }, 60 * 60 * 1000).unref();
}

function ingestAndDispatch(filePath: string) {
  try {
    const r = ingestFile(filePath);
    if (r.newEvents.length || r.touchedSessions.size) {
      dispatch(r);
    }
  } catch (err) {
    console.error("[ingest] failed:", filePath, err);
  }
}

// Live watcher (chokidar). Primary path on macOS via fsevents.
startWatcher(PROJECTS_DIR, ingestAndDispatch);

// Mtime-based safety net. fsevents drops change events under load and chokidar
// has no way to recover them. Every SWEEP_INTERVAL_MS we re-stat every JSONL
// and re-ingest any file whose mtime advanced past what we last saw. The walk
// is stat-only when nothing changed (no reads), so the steady-state cost is
// trivial. ingestFile is byte-offset idempotent, so a stat-walk that races
// the chokidar callback is a no-op.
const SWEEP_INTERVAL_MS = 2_000;
const lastMtime = new Map<string, number>();
setInterval(() => {
  walkJsonl(PROJECTS_DIR, (filePath) => {
    let s;
    try {
      s = statSync(filePath);
    } catch {
      return;
    }
    const prev = lastMtime.get(filePath);
    if (prev !== undefined && prev >= s.mtimeMs) return;
    lastMtime.set(filePath, s.mtimeMs);
    ingestAndDispatch(filePath);
  });
}, SWEEP_INTERVAL_MS).unref();

const app = createApp();
attachStaticFrontend(app);

console.log(`[claude-monitor v2] listening on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 240,
};
