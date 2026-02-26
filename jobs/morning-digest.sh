#!/bin/bash
# Morning digest — compiles overnight changelog into a single Slack message
# Pure bash — no Claude call needed. Parses changelog.md structurally.

set -euo pipefail

CRANIUM_DIR="${CRANIUM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
CHANGELOG="$CRANIUM_DIR/audits/changelog.md"
TODAY=$(date +%Y-%m-%d)

# Source env vars for Slack posting
set -a
source "$CRANIUM_DIR/.env"
set +a

# Extract all lines for today's date entries from changelog
# Pattern: everything between "## YYYY-MM-DD" matching today and the next date header
TODAY_ENTRIES=$(awk -v date="$TODAY" '
  /^## [0-9]{4}-[0-9]{2}-[0-9]{2}/ {
    if ($2 == date) { capture=1; next }
    else if (capture) { capture=0 }
  }
  capture { print }
' "$CHANGELOG")

# If nothing happened overnight, stay silent
if [ -z "$TODAY_ENTRIES" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [digest] No changelog entries for $TODAY — staying silent" >> "$CRANIUM_DIR/cron.log"
  exit 0
fi

# Extract category names from headers (## YYYY-MM-DD — Category Name)
CATEGORIES=$(grep "^## ${TODAY}" "$CHANGELOG" | sed "s/^## ${TODAY} — //" | sed 's/ (catch-up)//' | sed 's/ (manual.*)//')

# Count fixes/actions
FIX_COUNT=$(echo "$TODAY_ENTRIES" | grep -c '^\- \[fixed\]' || true)
ACTION_LINES=$(echo "$TODAY_ENTRIES" | awk '/^### Actions Taken/,/^###/' | grep '^\- ' || true)
ACTION_COUNT=$(echo "$ACTION_LINES" | grep -c '.' || true)
TOTAL_ACTIONS=$((FIX_COUNT + ACTION_COUNT))

# Extract "Flagged for Owner" / "Needs you" items
FLAGGED=$(echo "$TODAY_ENTRIES" | awk '/^### Flagged for/,/^---/' | grep '^\- \|^[0-9]\.' || true)
NEEDS_OWNER=$(echo "$TODAY_ENTRIES" | awk '/^### Needs/,/^---/' | grep '^\- \|^[0-9]\.' || true)

# Build the digest message
MSG="*Overnight Digest — ${TODAY}*\n\n"

# Jobs that ran
MSG+="*Ran:* "
CATEGORY_LIST=""
while IFS= read -r cat; do
  [ -z "$cat" ] && continue
  if [ -z "$CATEGORY_LIST" ]; then
    CATEGORY_LIST="$cat"
  else
    CATEGORY_LIST="$CATEGORY_LIST, $cat"
  fi
done <<< "$CATEGORIES"
MSG+="${CATEGORY_LIST}\n"

# Summary stats
if [ "$TOTAL_ACTIONS" -gt 0 ]; then
  MSG+="*Actions:* ${TOTAL_ACTIONS} fix(es)/change(s) applied automatically\n"
fi

# Key actions (top 5 fixes)
if [ "$FIX_COUNT" -gt 0 ]; then
  MSG+="\n*Key fixes:*\n"
  TOP_FIXES=$(echo "$TODAY_ENTRIES" | grep '^\- \[fixed\]' | head -5 | sed 's/^\- \[fixed\]: /• /' | sed 's/^\- \[fixed\] /• /')
  MSG+="${TOP_FIXES}\n"
  if [ "$FIX_COUNT" -gt 5 ]; then
    REMAINING=$((FIX_COUNT - 5))
    MSG+="  _...and ${REMAINING} more_\n"
  fi
fi

# Key actions from "Actions Taken" sections
if [ "$ACTION_COUNT" -gt 0 ]; then
  MSG+="\n*Other actions:*\n"
  TOP_ACTIONS=$(echo "$ACTION_LINES" | head -5 | sed 's/^- /• /' | sed 's/^[0-9]\. /• /')
  MSG+="${TOP_ACTIONS}\n"
fi

# Anything that needs the operator
ALL_FLAGGED=""
if [ -n "$FLAGGED" ]; then
  ALL_FLAGGED="$FLAGGED"
fi
if [ -n "$NEEDS_OWNER" ]; then
  if [ -n "$ALL_FLAGGED" ]; then
    ALL_FLAGGED="${ALL_FLAGGED}\n${NEEDS_OWNER}"
  else
    ALL_FLAGGED="$NEEDS_OWNER"
  fi
fi

if [ -n "$ALL_FLAGGED" ]; then
  MSG+="\n:warning: *Needs you:*\n"
  FORMATTED_FLAGS=$(echo -e "$ALL_FLAGGED" | head -5 | sed 's/^- /• /' | sed 's/^[0-9]\. \?/• /')
  MSG+="${FORMATTED_FLAGS}\n"
fi

# Post to Slack
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_DM_CHANNEL:-}" ]; then
  ESCAPED=$(echo -e "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"channel\":\"$SLACK_DM_CHANNEL\",\"text\":$ESCAPED}" \
    https://slack.com/api/chat.postMessage > /dev/null
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [digest] Posted morning digest (${TOTAL_ACTIONS} actions, categories: ${CATEGORY_LIST})" >> "$CRANIUM_DIR/cron.log"
