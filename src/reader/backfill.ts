/**
 * One-shot CLI: walk ~/.claude/projects/**\/*.jsonl and ingest into the v2 DB.
 * Usage: bun run src-v2/reader/backfill.ts
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ingestFile } from "./ingest.ts";
import { db, DB_FILE } from "../db.ts";
import { recomputeAllStates } from "../state/project.ts";
import { runMigrations } from "../migrations.ts";

const PROJECTS_DIR =
  process.env.CC_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");

function findJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...findJsonl(full));
    else if (s.isFile() && full.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

const start = Date.now();
const files = findJsonl(PROJECTS_DIR);
console.log(`[backfill] DB: ${DB_FILE}`);
console.log(`[backfill] found ${files.length} .jsonl files under ${PROJECTS_DIR}`);

let totalNew = 0;
let totalTouched = 0;
for (const f of files) {
  try {
    const { newEvents, touchedSessions } = ingestFile(f);
    totalNew += newEvents.length;
    totalTouched += touchedSessions.size;
  } catch (err) {
    console.error(`  ! failed ${f}:`, err);
  }
}

const ingestMs = Date.now() - start;
console.log(`[backfill] ingest: ${totalNew} new events, ${totalTouched} session touches in ${ingestMs}ms`);

for (const m of runMigrations()) {
  if (m.ran) console.log(`[migration] ${m.key}: ${m.details ?? "done"}`);
}

const projStart = Date.now();
const projected = recomputeAllStates();
const projMs = Date.now() - projStart;
console.log(`[backfill] projected ${projected} sessions in ${projMs}ms`);

const sessionCount = (db.query("SELECT COUNT(*) as c FROM sessions").get() as any).c;
const eventCount = (db.query("SELECT COUNT(*) as c FROM events").get() as any).c;
console.log(`[backfill] total: ${sessionCount} sessions, ${eventCount} events`);
