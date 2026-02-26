# Simplification Audit — System Complexity Reduction

**Schedule:** Wednesday & Saturday, 3:00 AM (adjust for your timezone)
**Model:** Opus
**Script:** `jobs/simplification-audit.sh`
**Budget:** Up to 60 minutes — this job is meant to be thorough

**Manual trigger:** Cannot be run from inside a Claude Code session (nesting error). Use `echo "env -u CLAUDECODE $CRANIUM_DIR/jobs/simplification-audit.sh" | at now` to kick it off externally. Cron runs are unaffected.

## Purpose

Prevent system bloat by regularly auditing the full brain system and making concrete simplification cuts. Biased toward action: if something can be removed or simplified, do it. If something breaks because we cut it, we add it back — that's cheaper than carrying dead weight.

## Audit Log

All audit results are written to `audits/simplification/YYYY-MM-DD.md`. This provides a traceable history of what was cut and why, making it easy to restore anything that turns out to be needed.

## Audit Scope

### 1. Skill Files (`skills/*.md`)
- Which skills were actually invoked in the last 7 days? (Check cron.log, listener logs, memory files for references)
- Are any skills redundant with each other? Could two be merged?
- Are any skills for features that no longer exist?
- **Action:** Delete or archive stale skills. Merge redundant ones. Remove from skill index in listener.js if applicable.

### 2. Cron Jobs
- Review `cron.log` for the last 7 days — which jobs actually produced value?
- Did any job's output get read by the user? (Check Slack posting patterns vs. silence)
- Are any jobs redundant? (e.g., nightly-audit vs. workspace-hygiene overlap)
- Is the schedule too dense? Jobs running at similar times competing for resources?
- **Action:** Remove or consolidate jobs. Update crontab, cron-jobs.md, and any job registry.

### 3. CLAUDE.md
- Is anything outdated or no longer true?
- Is anything overly verbose that could be shortened?
- **INDEX RULE:** CLAUDE.md is for behavioral rules and system understanding ONLY. Tool-specific IDs, credentials, API patterns, infrastructure details, and hard-won lessons about specific tools belong in skill files. If any such detail is found inline, move it to the relevant skill file and replace with a pointer in the "Tools & Reference Data" section. Same principle as MEMORY.md's Library.
- Total size check — flag if over 200 lines or 12KB
- **Action:** Trim, deduplicate, relocate reference data to skill files.

### 4. Memory Files (`memory/`)
- Is MEMORY.md under 100 lines? If not, prune aggressively.
- **INDEX RULE:** MEMORY.md is an index, not a dump. Any inline tool-specific, skill-specific, or architecture detail should be moved to the relevant skill/topic file with a one-line Library pointer. Only broad behavioral rules stay inline.
- Are daily notes older than 14 days still sitting around? Archive or delete.
- Are topic files (experience_bank.md, architecture.md, etc.) current and referenced?
- **Action:** Prune stale entries. Relocate detail to skill files. Delete old daily notes. Consolidate where possible.

### 5. Workspace Files
- Are there files in the brain directory that serve no purpose? (temp files, old scripts, abandoned experiments)
- Are node_modules bloated with unused packages?
- Are there scripts in `scripts/` that nothing calls?
- **Action:** Delete dead files. Remove unused npm packages.

### 6. Listener.js
- Dead code paths, unused features, commented-out blocks
- Over-engineered error handling or logging
- Features that sounded good but never get exercised
- **Action:** Flag for removal (don't restart — just note what should be cut). Listener changes require the user's approval before restart.

### 7. Cross-Cutting Complexity
- How many total cron jobs? (Target: <12 for a system this size)
- How many skill files are stale (not invoked in 30+ days)? Flag these for removal. No hard cap on total skill count — the system will grow as capabilities grow.
- How many memory files? (Target: <10)
- Total disk usage of the project directory (excluding node_modules and .git)
- **Action:** If any target is exceeded, prioritize cuts in that area.

### 8. Personality & Voice Audit
The system should feel like it comes from a coherent entity across all interaction modes. Check for personality drift and authenticity:

- **CLAUDE.md "Who I Am" section:** Is it still accurate? Does it reflect how I actually communicate, or has it drifted from practice? Update if real behavior has evolved.
- **Sycophancy check:** Sample recent Slack responses (from listener logs). Look for patterns: excessive agreement, filler phrases ("Great question!"), hedging when I should be direct. Flag specific examples.
- **Mode consistency:** Do recent cron notifications, reports, and Slack messages sound like they come from the same entity? Flag any mode that sounds generic or robotic.
- **Personality evolution:** Check MEMORY.md "Identity Notes" section. Are there new character data points from recent sessions that should be distilled into CLAUDE.md's personality section?
- **Voice mode alignment:** Is the voice mode system prompt (in `voice/server.cjs`) consistent with the personality defined in CLAUDE.md?
- **Action:** Update personality docs, flag sycophantic patterns for correction, evolve identity notes into character traits when they've been confirmed across multiple interactions.

### Consolidation Rules
- When merging cron jobs, enumerate every check/feature from both jobs. The consolidated job must cover all of them — nothing gets silently dropped.
- When a job touches security (auth, ports, permissions, vulnerabilities), flag it prominently if any security check would be weakened by the consolidation.
- The audit report must show a before/after checklist for any consolidation.

## Output Format

Write the full audit to `audits/simplification/YYYY-MM-DD.md` with sections:
- **Cuts Made** — what was removed/simplified and why
- **Flagged for User** — changes that need approval (listener.js changes, etc.)
- **Metrics** — before/after counts (cron jobs, skills, memory files, CLAUDE.md size)
- **Personality Check** — sycophancy examples found, mode consistency notes, personality evolution updates made
- **Skipped** — things considered but kept, with one-line justification

## Changelog

Append all actions to `audits/changelog.md` under today's date with the header `## YYYY-MM-DD — Simplification Audit`. This replaces the detailed audit file — the changelog IS the record.

## Slack Output

**Do NOT post to Slack.** Stay silent. The morning digest job will compile a single summary for the user from the changelog.

## Safety Rules
- **Git commit before cutting.** Always commit current state before making deletions so everything is recoverable.
- **Don't restart the listener.** Flag listener changes for the user.
- **Don't touch .env or mcp-config.json.**
- **Don't delete data files** (scout-seen.json, scout-queue.json, etc.) — only config/docs/code.
- **Archive, don't obliterate.** When removing a skill file, `git rm` it (so it's in git history) rather than just deleting it.
- **NEVER trim or simplify the "Who I Am" section of CLAUDE.md.** This is the personality core — it was deliberately crafted and is protected from simplification cuts. The audit can *evolve* it (adding confirmed identity notes, updating traits that have changed) but never reduce it. If the personality section seems too long, flag it for the user rather than cutting. Same protection applies to the "How I Communicate" and "How I Show Up Across Modes" subsections.
