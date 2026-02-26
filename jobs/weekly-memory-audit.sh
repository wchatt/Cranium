#!/bin/bash
# Weekly memory audit — invoked by cron via crontab
# Opus-tier: requires judgment across the full memory system
# Fixed 2026-02-23: removed exec timeout (killed process before logging),
# trimmed prompt scope to avoid context/timeout issues.

CRANIUM_DIR="${CRANIUM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

PROMPT='Run a weekly memory audit. You are curating your own long-term memory system.

Phase 1 — Daily notes triage:
- List files in '"$CRANIUM_DIR"'/memory/ matching YYYY-MM-DD.md
- Read daily notes from the past 7 days. Extract key decisions, lessons, and outcomes.
- Delete daily notes older than 14 days ONLY after confirming their key info exists in MEMORY.md or a skill file.
- NEVER delete memory/time-log.md — this is the durable weekly time log that persists forever for monthly/quarterly trend visibility.

Phase 2 — MEMORY.md curation:
- Read '"$CRANIUM_DIR"'/memory/MEMORY.md in full.
- Check every section: is it still accurate? Is anything stale or duplicated from CLAUDE.md?
- INDEX RULE: MEMORY.md is an index, not a dump. Tool-specific or skill-specific details belong in skill files with a one-line Library pointer in MEMORY.md.
- Promote any durable lessons from this weeks daily notes into the relevant skill file, then add a Library pointer if the topic isnt already indexed.
- Keep MEMORY.md under 100 lines.

Phase 3 — Skill file spot-check:
- Pick 3-4 skill files that were referenced in this weeks daily notes and read them.
- Fix any contradictions with MEMORY.md or stale info you find.
- Do NOT attempt to read every skill file — focus on what changed this week.

If you made meaningful changes, start output with [NOTIFY] and summarize: what was stale, promoted, pruned, and which files were touched. If nothing meaningful changed, stay silent (no [NOTIFY]).'

# Run via cron-run.sh (handles logging and Slack delivery)
# No exec — allows cron-run.sh to log even if claude times out
"$CRANIUM_DIR/cron-run.sh" opus "$PROMPT"
