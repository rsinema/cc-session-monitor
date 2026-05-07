# Claude Code JSONL Schema (observed 2026-05)

Each line in `~/.claude/projects/<slug>/<sessionId>.jsonl` is a JSON object with a `type` field. The slug is the absolute project path with `/` replaced by `-`.

## Entry types

| `type` | Purpose | Has `message`? | Notes |
|---|---|---|---|
| `permission-mode` | Marks current permission mode (auto / plan / etc.) | No | `{type, permissionMode, sessionId}` |
| `file-history-snapshot` | Tracks file backups Claude maintains | No | `{type, messageId, snapshot, isSnapshotUpdate}` |
| `user` | A user turn (typed message OR tool_result reply) | Yes | See "User" below |
| `assistant` | An assistant turn | Yes | See "Assistant" below |
| `attachment` | System-side attachment (deferred tools delta, file paste, skill listing, etc.) | No | `{type, attachment, …}` |
| `ai-title` | Generated session title | No | `{type, sessionId, aiTitle}` |
| `last-prompt` | Pointer to last user prompt | No | `{type, sessionId, leafUuid, lastPrompt}` |

## Envelope fields (on user/assistant/attachment)

```
cwd          string   absolute project path (decoded slug)
entrypoint   string   "cli" | etc.
gitBranch    string   e.g. "main" or "HEAD"
isSidechain  bool     true for subagent/branched flow
parentUuid   string?  uuid of parent message; null for root
sessionId    string   session uuid
slug         string   the directory slug
timestamp    string   ISO 8601, e.g. "2026-05-07T15:58:01.590Z"
userType     string   "external" / etc.
uuid         string   message uuid (PK)
version      string   Claude Code version
```

User/assistant additionally have `message` and `promptId`. Tool-result user entries also carry `requestId`, `sourceToolAssistantUUID`, and a top-level `toolUseResult`.

## User messages

`message.role === "user"`. `message.content` is one of:

1. **String** — raw user-typed text. The "real" prompt.
2. **Array** of `tool_result` blocks: `{type: "tool_result", tool_use_id, content}` where `content` is usually a string but can be an array of content blocks too.

Identifying a "real user prompt" vs a "tool_result reply": check if `content` is a string, or look at the first block type.

## Assistant messages

`message.role === "assistant"`. `message.content` is always an array. Block shapes:

```
{ type: "text",     text: "..." }
{ type: "thinking", thinking: "..." }   // text lives in .thinking, not .text
{ type: "tool_use", id: "toolu_…", name: "Read", input: { … } }
```

`message.model` (e.g. `"claude-opus-4-7"`) is also present.

## Tool linkage

A `tool_use` block from an assistant message has an `id` like `toolu_…`. The matching `tool_result` block (in a later user message) carries `tool_use_id` referencing that id.

The user envelope for a tool result also includes `sourceToolAssistantUUID` (the assistant message uuid that produced the call) and a top-level `toolUseResult` field whose shape varies by tool (e.g. `{stdout, stderr, interrupted, isImage, noOutputExpected}` for Bash).

## Attachments (skip for transcript)

Observed `attachment.type` values: `deferred_tools_delta`, `file`, `skill_listing`, `task_reminder`, `plan_mode_exit`, `auto_mode`. v1 stores these as a synthetic system-typed message but does not render most of them.

## Things to flatten into `text_preview` (for FTS / list display)

- User string content → as-is
- Tool result `content` (string) → as-is, truncate ~2000 chars
- Assistant `text` blocks → concatenated
- Assistant `thinking` blocks → optional, prefix with "[thinking] "
- Assistant `tool_use` → "[tool] {name} {JSON.stringify(input).slice(0,400)}"

## Inferring session metadata

- `started_at` = earliest `timestamp` of any user/assistant entry
- `last_activity` = latest `timestamp`
- `project_path` = `cwd` from any envelope (constant within a session)
- `project_name` = last segment of `project_path`

## Edge cases

- The very first lines of a fresh session may be only `permission-mode` + `file-history-snapshot` with no user/assistant yet — `started_at` cannot be derived until the first real message lands.
- `parentUuid` chains can branch (sidechains for subagents). Render in timestamp order; do not assume a tree.
- Tool results can be massive (file contents, command output). Keep full text in `content` but truncate `text_preview` for the FTS index.
- Attachments and meta-types (`permission-mode`, `ai-title`, `last-prompt`, `file-history-snapshot`) lack `uuid` for some shapes — generate one from `sha1(line)` if we choose to ingest them.
