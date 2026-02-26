#!/bin/bash
# Cron wrapper for Claude Code CLI
# Usage: cron-run.sh <model> "<prompt>"
# CLAUDE.md is auto-loaded from CRANIUM_DIR (working directory).
# Posts to Slack only if Claude's output starts with [NOTIFY].
#
# Auth: If ANTHROPIC_API_KEY is set in .env, cron jobs authenticate via API key
# (pay-per-token). This is the recommended approach for automated/headless usage
# per Anthropic's terms. If not set, falls back to consumer subscription auth.

set -euo pipefail

MODEL="${1:?Usage: cron-run.sh <model> <prompt>}"
PROMPT="${2:?Usage: cron-run.sh <model> <prompt>}"
CRANIUM_DIR="$(cd "$(dirname "$0")" && pwd)"
PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Source env vars
set -a
source "$CRANIUM_DIR/.env"
set +a

# Prevent "nested session" error if CLAUDECODE env var leaks from parent
unset CLAUDECODE 2>/dev/null || true

# If ANTHROPIC_API_KEY is set, export it so claude uses API key auth.
# This is the ToS-compliant path for automated (non-interactive) usage.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_API_KEY
fi

# Run Claude Code — CLAUDE.md auto-loads from cwd, no --append-system-prompt needed
RESULT=$(claude -p "$PROMPT" \
  --model "$MODEL" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch" \
  --dangerously-skip-permissions \
  --output-format text \
  --no-session-persistence \
  2>&1) || true

# Log first 300 chars of result for debugging
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [${MODEL}] result_preview: ${RESULT:0:300}" >> "$CRANIUM_DIR/cron.log"

# Post result to Slack only if Claude explicitly requests it via [NOTIFY]
if echo "$RESULT" | grep -q '^\[NOTIFY\]'; then
  # Strip the [NOTIFY] marker and post the rest
  MESSAGE=$(echo "$RESULT" | sed '1s/^\[NOTIFY\]//' | sed '1s/^ *//')

  if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "${SLACK_DM_CHANNEL:-}" ]; then
    # Escape for JSON
    ESCAPED=$(echo "$MESSAGE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
    curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$SLACK_DM_CHANNEL\",\"text\":$ESCAPED}" \
      https://slack.com/api/chat.postMessage > /dev/null
  fi
fi

# Also log locally
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [${MODEL}] ${PROMPT:0:80}..." >> "$CRANIUM_DIR/cron.log"
