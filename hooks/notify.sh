#!/bin/bash
# Forward a Claude Code hook event (passed as JSON on stdin) to the local monitor.
# Always exits 0 so a stopped monitor never blocks Claude Code.
payload=$(cat)
curl -s -X POST http://localhost:3737/api/hook/notify \
  -H "Content-Type: application/json" \
  -d "$payload" \
  --max-time 2 \
  >/dev/null 2>&1 || true
exit 0
