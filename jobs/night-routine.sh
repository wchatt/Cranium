#!/bin/bash
# Night Routine — End-of-day Notion cleanup & continuity
# Runs at 11:59 PM EST as a fallback if operator didn't trigger it manually.
# Skips silently if the routine already ran today (checks daily notes for marker).

set -euo pipefail

CRANIUM_DIR="${CRANIUM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
TODAY=$(TZ="${CRANIUM_TZ:-America/New_York}" date +%Y-%m-%d)
DAILY_NOTES="$CRANIUM_DIR/memory/$TODAY.md"

# Check if night routine already ran today
if [ -f "$DAILY_NOTES" ] && grep -q '## Night Routine — Completed' "$DAILY_NOTES"; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [night-routine] Already ran today, skipping." >> "$CRANIUM_DIR/cron.log"
  exit 0
fi

PROMPT="Run the night routine. Read skills/night-routine.md for full instructions. This is the automated cron fallback — the routine was NOT triggered manually today, so run the full flow. Remember: MCP tools are not available in cron, use curl for Notion API calls. Start output with [NOTIFY] followed by the summary."

exec "$CRANIUM_DIR/cron-run.sh" sonnet "$PROMPT"
