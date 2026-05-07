# Claude Code Session Monitor — Build Plan

A local-only web UI for monitoring Claude Code sessions on macOS. Built with Bun + Hono on the backend and React on the frontend. Single repo, single process where possible.

## Goals (v1, in priority order)

1. **Live session list + message view** — see all sessions across all projects, click into one to read the full transcript, see new messages appear without refreshing.
2. **Search across past sessions** — full-text search over all historical messages, with results that link back to the session/message.
3. **Approval notifications** — when Claude Code is waiting on a permission prompt (tool approval), push a desktop notification so you don't have to watch the terminal.

Anything not on this list is out of scope for v1. No multi-machine, no cost tracking, no auth, no remote access. If you find yourself adding features mid-build, write them down for v2 and keep moving.

## What you're working with

Claude Code writes session data to `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`. Each line is a JSON object representing one event in the session — user messages, assistant messages, tool uses, tool results, and system events. The project slug is the project's absolute path with `/` replaced by `-` (e.g. `/Users/riley/code/enzy` becomes `-Users-riley-code-enzy`).

Before writing a single line of code, **run this and look at the output**:

```bash
ls ~/.claude/projects/
# pick a recent project, then:
ls ~/.claude/projects/<some-project-slug>/
# pick the most recent .jsonl, then:
tail -n 5 ~/.claude/projects/<some-project-slug>/<some-session>.jsonl | jq .
```

This is the single most important step. The exact JSONL schema (field names, message structure, tool use format) is what your whole app is built on, and it's easier to read 20 real lines than to guess. Note the structure of:
- User messages (top-level shape, where the text content lives)
- Assistant messages (text content vs. tool_use blocks)
- Tool results (how they reference the tool_use that triggered them)
- The `timestamp`, `sessionId`, `parentUuid`, `cwd` fields

Write down the schema in a `SCHEMA.md` in your repo before building parsers. Future-you will thank you.

Claude Code also has a **hooks system** configured via `~/.claude/settings.json`. Hooks fire shell commands on events like `PreToolUse`, `PostToolUse`, `Notification`, and `Stop`. We'll use the `Notification` hook (which fires when Claude Code needs user input/approval) to power the approval notifications feature.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Single Bun process on localhost:3737                   │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Hono server                                      │  │
│  │  ├── GET  /api/sessions       (list)              │  │
│  │  ├── GET  /api/sessions/:id   (full transcript)   │  │
│  │  ├── GET  /api/search?q=...   (FTS)               │  │
│  │  ├── POST /api/hook/notify    (hook callback)     │  │
│  │  ├── GET  /api/stream         (SSE for live)      │  │
│  │  └── GET  /*                  (serve React app)   │  │
│  └───────────────────────────────────────────────────┘  │
│                          ▲                              │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │  File watcher (chokidar) on ~/.claude/projects/   │  │
│  │  → parses new JSONL lines                         │  │
│  │  → upserts into SQLite                            │  │
│  │  → broadcasts to SSE clients                      │  │
│  └───────────────────────────────────────────────────┘  │
│                          ▲                              │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │  SQLite (better-sqlite3 or bun:sqlite)            │  │
│  │  + FTS5 virtual table for search                  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
        ▲                               ▲
        │                               │
   Browser (React)            Claude Code hook script
                              POSTs on Notification event
```

One process, one port, one database file. SSE (server-sent events) instead of WebSockets because it's simpler for one-way push and Hono supports it natively.

## Tech choices (don't bikeshed these)

- **Runtime**: Bun (you already have it)
- **Server**: Hono
- **DB**: SQLite via `bun:sqlite` (built-in, zero deps, has FTS5)
- **File watching**: `chokidar` (battle-tested, handles macOS quirks)
- **Frontend**: React + Vite, served as static files by Hono in production
- **Styling**: Tailwind (fastest to vibe with)
- **State**: TanStack Query for server state, plain `useState` for the rest. No Redux, no Zustand.
- **Notifications**: macOS native via `osascript` shelled out from the hook handler, plus browser `Notification` API as a fallback when the page is open

## Data model

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- session UUID
  project_path TEXT NOT NULL,    -- decoded cwd, e.g. /Users/riley/code/enzy
  project_name TEXT NOT NULL,    -- last segment of project_path
  started_at INTEGER NOT NULL,   -- unix ms, from first message timestamp
  last_activity INTEGER NOT NULL,-- unix ms, from latest message timestamp
  message_count INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,       -- absolute path to .jsonl
  awaiting_input INTEGER NOT NULL DEFAULT 0  -- 1 if a Notification hook fired and no Stop yet
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- uuid from JSONL
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_id TEXT,                -- parentUuid
  role TEXT NOT NULL,            -- 'user' | 'assistant' | 'system'
  type TEXT NOT NULL,            -- 'text' | 'tool_use' | 'tool_result' | 'system'
  content TEXT NOT NULL,         -- raw JSON of the content blocks
  text_preview TEXT,             -- flattened text for search/display
  timestamp INTEGER NOT NULL,
  line_number INTEGER NOT NULL   -- offset in source file, for incremental parsing
);

CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX idx_sessions_activity ON sessions(last_activity DESC);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text_preview,
  content=messages,
  content_rowid=rowid
);
-- plus triggers to keep FTS in sync; standard FTS5 boilerplate
```

`awaiting_input` is the flag that drives notification badges in the UI. It flips to 1 when a `Notification` hook POSTs in, and back to 0 when a `Stop` hook fires or a new user message lands.

## Build order

Do these phases in order. Don't skip ahead. Each phase ends with something you can actually use.

### Phase 0: Schema discovery (30 min, no code)

1. Run the `tail | jq` commands above on 3-4 of your real recent sessions.
2. Write `SCHEMA.md` documenting the JSONL fields you'll need. At minimum: how to identify the role, how to extract text content, how tool_use and tool_result are linked, where the timestamp lives.
3. Note any edge cases (empty messages, sidechain messages, summary entries, etc).

### Phase 1: Parser + DB, no UI (~1 hr)

1. `bun init`, add deps: `hono`, `chokidar`, `@hono/node-server` (if needed).
2. Write `src/db.ts` — opens `~/.claude-monitor/db.sqlite`, runs the schema migration on startup, exports a singleton.
3. Write `src/parser.ts` — pure function `parseLine(line: string): ParsedEvent | null`. Unit-test it against fixtures you save from Phase 0.
4. Write `src/ingest.ts` — given a file path, reads from `line_number` offset onward and upserts messages + updates the session row.
5. Write a one-shot CLI: `bun run src/backfill.ts` walks `~/.claude/projects/`, ingests every `.jsonl` into the DB.
6. Verify with `sqlite3 ~/.claude-monitor/db.sqlite "select count(*) from messages;"` — should be a big number.

**Done when**: you can query your full session history with raw SQL.

### Phase 2: Read API + minimal UI (~2 hrs)

1. Set up Hono server in `src/server.ts` listening on `localhost:3737`.
2. Implement read endpoints:
   - `GET /api/sessions` — returns sessions ordered by `last_activity DESC`, paginated (limit 50). Include `project_name`, `started_at`, `last_activity`, `message_count`, `awaiting_input`.
   - `GET /api/sessions/:id` — returns the session metadata + all messages ordered by timestamp.
   - `GET /api/search?q=...` — uses `messages_fts MATCH ?`, joins back to messages and sessions, returns top 50 results with snippets.
3. Set up Vite + React in a `web/` subdirectory. Keep it stupid simple:
   - `App.tsx` with a two-pane layout: session list on the left, transcript on the right.
   - Search bar at the top that flips the right pane to results when there's a query.
   - Use TanStack Query for fetching. Polling every 5s is fine for now; SSE comes in Phase 3.
4. Configure Vite to build to `web/dist` and have Hono serve it.

**Done when**: you can browse and search your sessions in the browser. Don't polish — make it functional and ugly. Polish is the last phase.

### Phase 3: Live updates via file watching + SSE (~1 hr)

1. In `src/server.ts` startup, instantiate chokidar watching `~/.claude/projects/**/*.jsonl`.
2. On `add` or `change`, call `ingest()` on the file. Capture the new messages it produced.
3. Maintain a Set of SSE clients. Add `GET /api/stream` that holds the connection open and pushes events.
4. After ingest, broadcast `{type: 'message', sessionId, message}` to all SSE clients. Also broadcast `{type: 'session_updated', session}` with the new metadata.
5. In the React app, open an `EventSource('/api/stream')` once, and on each event, use TanStack Query's `queryClient.setQueryData` to merge the update into the relevant cache.

**Watch out for**: chokidar fires `change` repeatedly during a long write. Your ingest function is already idempotent because it tracks `line_number`, but make sure you handle two `change` events arriving while the first is still parsing (a simple per-file mutex/queue is enough).

**Done when**: open the UI, run a Claude Code session in another terminal, and watch messages stream in live.

### Phase 4: Approval notifications (~1 hr)

This is the trickiest piece because it requires wiring into Claude Code's hooks. Two-part:

**4a. The hook script.** Create `~/.claude-monitor/hooks/notify.sh`:

```bash
#!/bin/bash
# Reads the hook event JSON from stdin, forwards to the monitor.
# Claude Code passes event data as JSON on stdin.
payload=$(cat)
curl -s -X POST http://localhost:3737/api/hook/notify \
  -H "Content-Type: application/json" \
  -d "$payload" \
  --max-time 2 \
  > /dev/null 2>&1 || true
# Always exit 0 so we never block Claude Code if the monitor is down.
exit 0
```

`chmod +x` it.

Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "/Users/riley/.claude-monitor/hooks/notify.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/Users/riley/.claude-monitor/hooks/notify.sh" }] }
    ]
  }
}
```

**Important**: before you write the hook config, check the current hooks docs (`https://docs.claude.com/en/docs/claude-code/hooks`) — the schema has evolved and you want to match what your installed version actually expects. Your existing settings file might also already have hooks; merge, don't overwrite.

**4b. The handler.**

`POST /api/hook/notify` receives the event payload. Inspect the `hook_event_name` field:
- `Notification` → set `awaiting_input = 1` on the session, fire a macOS notification, broadcast over SSE.
- `Stop` → set `awaiting_input = 0`, broadcast.

For the macOS notification, shell out:

```ts
import { spawn } from 'bun';
function notify(title: string, body: string) {
  spawn(['osascript', '-e',
    `display notification "${body.replace(/"/g, '\\"')}" with title "${title}" sound name "Glass"`
  ]);
}
```

In the React app, also call `Notification.requestPermission()` on first load and fire a browser notification when an SSE `awaiting_input` event arrives — covers the case where the page is open but not focused.

**Done when**: you start a Claude Code session, it asks for tool approval, and your Mac pings you within a second or two.

### Phase 5: Polish (as much time as you feel like)

Now and only now, make it nice:
- Sessions grouped by project in the sidebar
- Relative timestamps ("2m ago")
- Tool calls rendered with collapsible bodies (the JSON is noisy)
- Code blocks with syntax highlighting (`shiki` or `highlight.js`)
- A subtle pulsing indicator on sessions with `awaiting_input = 1`
- `cmd+k` to focus search
- Dark mode (your eyes will thank you)

## Project layout

```
claude-monitor/
├── package.json
├── bun.lockb
├── SCHEMA.md                  # Phase 0 output
├── src/
│   ├── server.ts              # Hono app, routes, SSE, watcher startup
│   ├── db.ts                  # SQLite connection + schema migration
│   ├── parser.ts              # JSONL line → ParsedEvent
│   ├── ingest.ts              # File → DB, idempotent on line_number
│   ├── watcher.ts             # chokidar setup
│   ├── backfill.ts            # one-shot CLI for initial import
│   ├── hooks.ts               # /api/hook/notify handler + osascript
│   └── types.ts
├── web/
│   ├── index.html
│   ├── vite.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api.ts             # fetch wrappers + EventSource
│   │   ├── components/
│   │   │   ├── SessionList.tsx
│   │   │   ├── Transcript.tsx
│   │   │   ├── Message.tsx
│   │   │   └── SearchBar.tsx
│   │   └── hooks/
│   │       └── useLiveUpdates.ts
│   └── dist/                  # built static files
└── hooks/
    └── notify.sh              # gets symlinked/copied into ~/.claude-monitor/
```

## Pitfalls to flag for the agent

1. **The JSONL files are appended to live.** Always read incrementally from the last known byte/line offset. Re-parsing the whole file on every `change` event will work but kills performance on long sessions.
2. **`parentUuid` chains can have gaps** (sidechains, branches). Don't assume a strict tree — render messages in timestamp order for v1.
3. **Tool results can be huge** (file contents, command output). Truncate `text_preview` to ~2000 chars for the FTS index; keep the full content in `content` for display.
4. **The hook script runs synchronously in Claude Code's process.** Keep `notify.sh` to a backgrounded curl with `--max-time 2`. If the monitor is down, Claude Code must not hang.
5. **macOS Notification permissions**: the first `osascript display notification` call may prompt. Test once manually before relying on it.
6. **Don't watch `~/.claude/` recursively without filtering.** There are other files in there (todos, plugins, etc.) you don't care about. Glob to `**/*.jsonl` only.
7. **Bun's SQLite is synchronous.** That's fine for a single-user local app, but don't do giant FTS queries on the request thread without `LIMIT`.

## Definition of done for v1

- [ ] `bun run dev` starts the server, file watcher, and Vite dev server
- [ ] `bun run build && bun run start` produces a single command that runs the whole thing in production mode
- [ ] Backfill imports your full session history in under a minute
- [ ] Live session list updates without refresh as you use Claude Code
- [ ] Search returns relevant results across all historical sessions in <200ms
- [ ] When Claude Code prompts for approval, you get a macOS notification within 2s
- [ ] You can quit the app and restart it without losing data or breaking ingest

## Day-one prompt to give Claude Code

When you start, paste this whole document into your Claude Code session along with:

> Read the plan and start with Phase 0. Before writing any code, do the schema discovery yourself by running the `tail | jq` commands on my actual session files and producing `SCHEMA.md`. Do not skip ahead. After each phase, stop and let me verify before moving on.

Make Claude Code work phase-by-phase. The temptation will be huge to one-shot the whole thing; resist it. Each phase has a clear "done when" — gate on those.
