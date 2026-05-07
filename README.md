# Claude Session Monitor

A local-only web UI for browsing your Claude Code sessions on macOS. Tail every project's transcript live, search across all of history, and get a desktop ping when Claude is waiting on a permission prompt.

Single Bun process, single port, single SQLite file under `~/.claude-monitor/`.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- macOS (for `osascript` notifications — the rest of the app works anywhere Bun runs)
- Claude Code installed, with sessions in `~/.claude/projects/`

## Install

```bash
bun install
```

## Run

```bash
# 1. One-time backfill of historical sessions into ~/.claude-monitor/db.sqlite
bun run backfill

# 2a. Dev mode (Hono on :3737 + Vite hot reload on :5173)
bun run dev
#   → open http://localhost:5173

# 2b. Production mode (single process, builds frontend then serves it)
bun run build
bun run start
#   → open http://localhost:3737
```

The watcher auto-ingests new lines from `~/.claude/projects/**/*.jsonl` as you use Claude Code. The page receives updates over SSE, no refresh needed.

## Approval notifications

The monitor exposes a hook callback at `POST /api/hook/notify`. A small forwarder script lives at `~/.claude-monitor/hooks/notify.sh` (installed automatically by the build steps above; the canonical copy is in `hooks/notify.sh`).

To wire it into Claude Code, add this to `~/.claude/settings.json` (merge with any existing `hooks` block):

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "/Users/<you>/.claude-monitor/hooks/notify.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/Users/<you>/.claude-monitor/hooks/notify.sh" }] }
    ]
  }
}
```

`Notification` flips a session's `awaiting_input` flag and fires a macOS banner. `Stop` clears it. The forwarder always exits 0, so a stopped monitor never blocks Claude Code.

The first `osascript display notification` call may prompt for Notification Center permission. Allow it once.

## Layout

```
src/
  server.ts       Hono app: REST + SSE + hook callback + static frontend
  db.ts           SQLite schema (sessions, messages, FTS5)
  parser.ts       JSONL line → ParsedEvent
  ingest.ts       File → DB, idempotent on line offset
  watcher.ts      chokidar wrapper with single-flight per file
  hooks.ts        Hook payload handler + osascript shellout
  bus.ts          In-process pub/sub for SSE broadcasts
  backfill.ts     One-shot CLI to import all historical sessions
  parser.test.ts  Unit tests
web/
  src/            React app (TanStack Query, Tailwind)
hooks/
  notify.sh       Hook forwarder; symlink/copy into ~/.claude-monitor/hooks/
SCHEMA.md         Notes on the JSONL shape this app parses
```

## Endpoints

| Method | Path                  | Purpose                                              |
|--------|-----------------------|------------------------------------------------------|
| GET    | `/api/health`         | Liveness                                             |
| GET    | `/api/sessions`       | All sessions, ordered by `last_activity DESC`        |
| GET    | `/api/sessions/:id`   | Session metadata + every message                     |
| GET    | `/api/search?q=...`   | FTS5 across `text_preview`, returns highlighted snippets |
| GET    | `/api/stream`         | SSE: `message`, `session_updated`, `awaiting_input`  |
| POST   | `/api/hook/notify`    | Claude Code hook payload sink                        |

## Development notes

- The DB lives at `~/.claude-monitor/db.sqlite`. Delete it to reset; run `bun run backfill` again.
- File ingestion is idempotent: each file's last-read line offset is persisted in `file_offsets`, so re-running over an unchanged file is a no-op.
- The watcher serializes per-file ingests with a single-flight queue so a long write that fires multiple `change` events doesn't double-parse.
- Tool results can be large — we store the full JSON in `messages.content` but truncate `text_preview` (FTS index) to ~4000 chars.
- `parentUuid` chains can branch (sidechains); the UI renders messages in timestamp order, not as a tree.

## Tests

```bash
bun test
```
