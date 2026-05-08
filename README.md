# Claude Session Monitor

A local-only web UI for browsing your Claude Code sessions on macOS. Tail every project's transcript live, search across all of history, and get a desktop ping when Claude is waiting for input.

Single Bun process, single port, single SQLite file under `~/.claude-monitor/`.

## What's new in v0.2

The session-status model is a real state machine, not a boolean. Every session
projects to exactly one state at a time:

- **WORKING** with sub-state `tool_in_flight`, `streaming`, or `subagent_running`
- **AWAITING_USER** with sub-state `permission_prompt`, `plan_approval`, `question`, or `turn_complete`
- **EXITED** (after `/exit`, no later activity)

All transitions are computed deterministically from the JSONL event log + tool
invocations + hook signals — no periodic janitor, no flag-flipping reconciliation.

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
# Coming from v0.1? wipe the old db (schema is incompatible):
rm -f ~/.claude-monitor/db.sqlite ~/.claude-monitor/db.sqlite-wal ~/.claude-monitor/db.sqlite-shm

# 1. Backfill historical sessions into ~/.claude-monitor/db.sqlite
bun run ingest

# 2a. Dev mode (Hono on :3737 + Vite hot reload on :5173)
bun run dev
#   → open http://localhost:5173

# 2b. Production mode (single process, builds frontend then serves it)
bun run build
bun run start
#   → open http://localhost:3737
```

The watcher picks up new lines from `~/.claude/projects/**/*.jsonl` as you use
Claude Code. The page receives updates over SSE, no refresh needed.

## Run via Docker

Two flows: building locally if you have the source, or pulling a published
image from Docker Hub if you're a teammate.

Works with Docker Desktop *or* Colima — the publish script and compose file
talk to whichever Docker daemon your `docker` CLI is pointed at. On Colima:

```bash
colima start --vm-type=vz   # Apple Silicon: vz is much faster than qemu
```

Multi-arch buildx push works in either environment because the script uses
the `docker-container` builder driver, which runs BuildKit + QEMU inside the
daemon's own VM rather than relying on host emulation.

### For teammates — pull and run

You need: a Docker engine (Docker Desktop or Colima) and the
`docker-compose.yml` file from this repo. Nothing else.

```bash
# Grab the compose file
curl -O https://raw.githubusercontent.com/rsinema/cc-session-monitor/main/docker-compose.yml

# Run it
docker compose up -d
#   → open http://localhost:3737
```

The image (`rsinema/claude-session-monitor:latest`) is pulled from Docker Hub
on first run. The compose file bind-mounts your host's `~/.claude`
(read-only) and `~/.claude-monitor` (read-write), and exposes port 3737.
Hooks fired by Claude Code on the host POST to `localhost:3737`, which maps
into the container — no extra wiring beyond the standard hook config.

```bash
docker compose down       # stop
docker compose logs -f    # follow
docker compose pull       # fetch the latest image, then `up -d` to apply
```

To pin a specific version or use a fork, set `MONITOR_IMAGE`:

```bash
MONITOR_IMAGE=rsinema/claude-session-monitor:abc1234 docker compose up -d
```

### For maintainers — test local changes

The consumer-facing `docker-compose.yml` deliberately has no `build:`
directive (so teammates without source never hit a build error). To test
local changes against the same compose file:

```bash
# Build locally with the same name compose expects, then up:
docker build -t rsinema/claude-session-monitor:latest .
docker compose up -d
```

Or for ad-hoc dev work without Docker, the regular `bun run dev` flow still
applies.

### For maintainers — publish to Docker Hub

```bash
DOCKER_HUB_USER=yourname bun run publish:image
#   builds linux/amd64 + linux/arm64, pushes :latest and :<git-sha>
```

The script checks for a running daemon, ensures `docker buildx` is set up,
prompts for `docker login` if you're not already authed, and pushes a
multi-arch manifest so both Intel and Apple-Silicon teammates can pull a
single tag.

Optional flags:

```bash
EXTRA_TAG=v0.3 DOCKER_HUB_USER=yourname bun run publish:image
IMAGE_NAME=session-monitor DOCKER_HUB_USER=yourname bun run publish:image
PLATFORMS=linux/amd64       DOCKER_HUB_USER=yourname bun run publish:image
```

### Caveats vs. running directly

- macOS Notification Center banners are gone — `osascript` doesn't exist in a
  Linux container and there's no path from container to the host's
  notification daemon. Browser notifications (when the page is open) still
  fire from the React app and are unaffected.
- On Linux hosts, bind-mounted files are owned by your host UID. If the
  container's default user can't write `~/.claude-monitor`, run with
  `UID=$(id -u) GID=$(id -g) docker compose up` and uncomment the `user:`
  line in `docker-compose.yml`. macOS hosts handle UID remapping automatically.
- Env vars `CC_PROJECTS_DIR` and `CC_MONITOR_DB` override the default
  `~/.claude/projects` and `~/.claude-monitor/db.sqlite` paths — used by the
  container to point at the bind-mount targets, but useful elsewhere too.

## Approval notifications

The monitor exposes a hook callback at `POST /api/hook/notify`. A small
forwarder script lives at `~/.claude-monitor/hooks/notify.sh` (canonical copy
in `hooks/notify.sh`).

To wire it into Claude Code, merge into `~/.claude/settings.json`:

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

`Notification` records a `hook_notification` event and flips the session into
`AWAITING_USER.permission_prompt`. `Stop` records a `hook_stop` event and
nudges a recompute. The forwarder always exits 0 so a stopped monitor never
blocks Claude Code.

The first `osascript display notification` may prompt for permission. Allow it.

## Layout

```
src/
  db.ts               schema + prepared statements
  server.ts           entry point: boot catchup, watcher, server
  reader/
    parse.ts          JSONL line → ParsedRow (pure)
    tail.ts           byte-offset based file tail (rotation-safe)
    ingest.ts         tail.ts + parse.ts → events table (transactional)
    watcher.ts        chokidar wrapper with single-flight per file
    backfill.ts       one-shot CLI: walks ~/.claude/projects/
  state/
    project.ts        the 6-step rule (the brain of the app)
    project.test.ts   unit tests for the rule
    recompute.test.ts integration tests (synthetic JSONL → state)
    hooks.ts          hook payload → events row + recompute
  server/
    api.ts            Hono routes
    sse.ts            SSE bus + event vocabulary
    dispatch.ts       ingest result → SSE broadcasts
    notify.ts         macOS osascript banner

src-v1/               original prototype, kept for reference (not built)

web/
  src/                React app (TanStack Query, Tailwind)
hooks/
  notify.sh           hook forwarder
```

## Endpoints

| Method | Path                          | Purpose                                                |
|--------|-------------------------------|--------------------------------------------------------|
| GET    | `/api/health`                 | Liveness                                               |
| GET    | `/api/sessions`               | All sessions, ordered by `last_event_ts DESC`          |
| GET    | `/api/sessions/:id`           | Session metadata + events + open tools                 |
| GET    | `/api/sessions/:id/events`    | Cursor-paginated history (events strictly before `before_ts`) |
| GET    | `/api/search?q=...`           | FTS5 across event previews                             |
| GET    | `/api/stream`                 | SSE: `event_appended`, `state_changed`, `tool_started`, `tool_completed`, `session_meta` |
| POST   | `/api/hook/notify`            | Claude Code hook payload sink                          |

## Development notes

- DB lives at `~/.claude-monitor/db.sqlite`. Override with `CC_MONITOR_DB`. Delete to reset; run `bun run ingest`.
- Event ingestion is byte-offset based (per `file_offsets.byte_offset`). Re-running over an unchanged file is a no-op.
- Events with the same `line_sha` are deduped, so rotation/copy doesn't double-insert.
- Tool results live in the events table as `user_tool_result` rows with the full JSON in `raw`; the FTS index is built from a truncated `text_preview`.
- `parentUuid` chains can branch (sidechains); the UI renders events in timestamp order.
- The state projection (`src/state/project.ts`) is pure. To debug a stuck session, fetch its events and call `project()` directly.

## Tests

```bash
bun test src
```

State-machine coverage is in `src/state/project.test.ts` (pure rule branches)
and `src/state/recompute.test.ts` (end-to-end through synthetic JSONL).
