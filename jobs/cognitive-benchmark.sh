#!/bin/bash
# Cognitive Benchmark — Measures brain (model) performance over time
# Runs standardized test prompts, scores responses, tracks trends.
# Unlike the nightly audit (body) or security audit (immune system),
# this tests whether the model itself is performing well under context load.
#
# Schedule: Fridays, 3:00 AM EST (08:00 UTC) — weekly, consolidated single prompt

set -euo pipefail

CRANIUM_DIR="${CRANIUM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Source env vars
set -a
source "$CRANIUM_DIR/.env"
set +a

# Run the benchmark script directly — it handles its own Claude invocations
RESULT=$(node "$CRANIUM_DIR/scripts/cognitive-benchmark.cjs" 2>&1) || true

# Log to cron.log
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [cognitive-benchmark] result_preview: ${RESULT:0:300}" >> "$CRANIUM_DIR/cron.log"

# Post result to Slack only if [NOTIFY] is present
if echo "$RESULT" | grep -q '^\[NOTIFY\]'; then
  MESSAGE=$(echo "$RESULT" | sed '1s/^\[NOTIFY\]//' | sed '1s/^ *//')

  if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "${SLACK_DM_CHANNEL:-}" ]; then
    ESCAPED=$(echo "$MESSAGE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
    curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$SLACK_DM_CHANNEL\",\"text\":$ESCAPED}" \
      https://slack.com/api/chat.postMessage > /dev/null
  fi
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [cognitive-benchmark] complete" >> "$CRANIUM_DIR/cron.log"
