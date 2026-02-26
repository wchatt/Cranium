#!/bin/bash
# Simplification Audit — system complexity reduction
# Runs Wed/Sat 3:00 AM EST (8:00 UTC) on Opus
# See skills/simplification-audit.md for full spec

CRANIUM_DIR="${CRANIUM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

PROMPT='Run a simplification audit of the full brain system. Follow skills/simplification-audit.md exactly.

You have up to 60 minutes. Be thorough — read every file, check every job, trace every reference. The goal is to CUT things, not report on them.

## Step-by-step

1. **Create audit log:** Write your findings to audits/simplification/'"$(date +%Y-%m-%d)"'.md as you go.

2. **Git safety net:** Run `git add -A && git commit -m "pre-simplification-audit snapshot"` before making any deletions. If nothing to commit, that is fine.

3. **Gather data:**
   - Read cron.log (last 7 days of entries)
   - Read journalctl -u cranium@$USER.service --no-pager --since "7 days ago" (look for which skills were triggered)
   - List all files: skills/*.md, memory/*.md, jobs/*.sh, scripts/*.cjs
   - Read CLAUDE.md, memory/MEMORY.md
   - Run: crontab -l
   - Check package.json for dependency count
   - Measure: wc -c CLAUDE.md memory/MEMORY.md; ls skills/*.md | wc -l; ls jobs/*.sh | wc -l

4. **Analyze each area** per the skill file (skills, cron jobs, CLAUDE.md, memory, workspace files, listener.js, cross-cutting metrics).

5. **Make cuts.** For each item you remove:
   - Use `git rm` for tracked files (preserves in git history)
   - Use `rm` for untracked files
   - Update any references (cron-jobs.md, CLAUDE.md, etc.)
   - Log what you cut and why in the audit file

6. **Commit cuts:** `git add -A && git commit -m "simplification audit: [brief summary]"`

7. **Write audit report** to audits/simplification/'"$(date +%Y-%m-%d)"'.md with: Cuts Made, Flagged for Owner, Metrics (before/after), Skipped.

8. **Notify if cuts were made:** Output [NOTIFY] followed by a brief summary (3-5 bullets). If nothing was cut, stay silent.

## Key principle: Bias toward cutting. The cost of carrying dead weight every session is higher than the cost of re-adding something if we miss it. If you are on the fence, cut it.'

exec "$CRANIUM_DIR/cron-run.sh" opus "$PROMPT"
