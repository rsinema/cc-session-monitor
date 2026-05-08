/**
 * One-shot CLI: walks ~/.claude/projects/ and ingests every .jsonl into the DB.
 *
 * Run with: bun run src/backfill.ts
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ingestFile } from "./ingest.ts";
import { db } from "./db.ts";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function findJsonlFiles(dir: string): string[] {
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
    if (s.isDirectory()) {
      out.push(...findJsonlFiles(full));
    } else if (s.isFile() && full.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const files = findJsonlFiles(PROJECTS_DIR);
  console.log(`[backfill] found ${files.length} .jsonl files under ${PROJECTS_DIR}`);

  const start = Date.now();
  let totalNew = 0;
  for (const f of files) {
    try {
      const { newEvents, touchedSessions } = ingestFile(f);
      if (newEvents.length || touchedSessions.size) {
        console.log(
          `  + ${f.replace(PROJECTS_DIR, "")}: ${newEvents.length} msgs, ${touchedSessions.size} sessions`
        );
      }
      totalNew += newEvents.length;
    } catch (err) {
      console.error(`  ! failed ${f}:`, err);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  const sessionCount = (db.query("SELECT COUNT(*) as c FROM sessions").get() as any).c;
  const messageCount = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c;
  console.log(
    `[backfill] done in ${elapsed}s. New messages: ${totalNew}. Total: ${sessionCount} sessions, ${messageCount} messages.`
  );
}

await main();
