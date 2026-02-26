# Skill: Cron Jobs

All times should be configured for your local timezone. UTC conversion depends on your offset.

## Active Jobs

| Job | Schedule | Model | Script/Command |
|-----|----------|-------|----------------|
| Health check | Daily 5:55 AM | Sonnet | inline prompt in crontab |
| Morning digest | Daily 6:00 AM | bash | `jobs/morning-digest.sh` |
| Security audit | Mon/Wed/Fri 2:30 AM | Opus | `jobs/security-audit.sh` |
| Nightly backup | Daily 3:45 AM | bash | `jobs/backup.sh` |
| Ops audit | Mon/Wed/Fri 4:00 AM | Opus | `jobs/nightly-audit.sh` |
| Weekly memory audit | Mondays 5:30 AM | Opus | `jobs/weekly-memory-audit.sh` |
| Workspace hygiene | Tue/Thu/Sat 1:00 AM | Opus | `jobs/workspace-hygiene.sh` |
| Cognitive benchmark | Fridays 3:00 AM | Opus | `jobs/cognitive-benchmark.sh` |
| Simplification audit | Wed/Sat 3:15 AM | Opus | `jobs/simplification-audit.sh` |
| Night routine (fallback) | Daily 11:50 PM | Sonnet | `jobs/night-routine.sh` |

## How It Works

1. Crontab entries invoke `cron-run.sh <model> "<prompt>"` or a job script in `jobs/`
2. **Claude-backed jobs:** scripts exec into `cron-run.sh` — use these when the prompt is too long for crontab
3. **Deterministic jobs:** scripts run directly as bash/Node.js without calling Claude (e.g., backup.sh, morning-digest.sh). These handle their own Slack posting via curl.
4. Claude runs with `--dangerously-skip-permissions` and the tools listed in `cron-run.sh`
5. **To post to Slack (Claude jobs):** output `[NOTIFY]` on the first line — the wrapper strips it and posts the rest
6. **To stay silent:** don't output `[NOTIFY]`

## Philosophy: Action Over Reporting

Nightly jobs are **maintenance**, not audits. Fix things, don't just flag them.

- **All nightly jobs stay silent** (no `[NOTIFY]`). They log actions to `audits/changelog.md` instead.
- **The morning digest** (6:00 AM) reads the changelog and posts a single compiled summary.
- **Only exceptions** that post directly: Night Routine (daily wins summary). Active security incidents also bypass the digest.
- **Changelog** (`audits/changelog.md`): rolling log of all automated actions. If something breaks, check here first.

## Job Scripts

Long-running or complex jobs live in `$CRANIUM_DIR/jobs/`:
- `nightly-audit.sh` — ops audit: operational health, performance trends, external service checks, documentation freshness, self-improvement
- `backup.sh` — commit and push uncommitted changes to GitHub (pure bash, no Claude call)
- `weekly-memory-audit.sh` — cross-references all memory files, promotes/prunes
- `security-audit.sh` — security-focused audit: secrets exposure, SSH hardening, open ports, auth logs, file permissions, npm vulnerabilities, crontab integrity, cloud service credential scanning
- `workspace-hygiene.sh` — Notion & file organization sweep
- `cognitive-benchmark.sh` — brain performance benchmark: runs tests in a single consolidated Opus call, scores responses, tracks quality trends. Weekly (Fridays).
- `night-routine.sh` — end-of-day task cleanup: marks completed tasks, creates missing tasks from daily work, flags carry-overs. Skips if already ran manually that day.
- `simplification-audit.sh` — system complexity reduction: audits skills, cron jobs, memory, CLAUDE.md, workspace files. Biased toward cutting. Logs to `audits/simplification/`.
- `morning-digest.sh` — compiles overnight changelog into a single Slack summary for the user (pure bash, no Claude call). Runs after all other jobs.

## Job Registry (Notion)

If you use Notion to track recurring jobs, maintain a registry database. When adding, changing, or removing jobs, update the registry too.

## Editing Jobs

**Short prompts:** Edit directly in crontab with `crontab -e`

**Long prompts (jobs/ scripts):** Edit the file in `jobs/`, no crontab change needed.

**Adding a new job:**
1. Decide if prompt fits in crontab (<~800 chars to be safe) or needs a `jobs/` script
2. Add the crontab entry — always comment with the local time
3. If creating a `jobs/` script, `chmod +x` it
4. Update this skill file
5. Update any Notion job registry if configured

## UTC Reference (for crontab syntax)
Crontab runs in UTC. Convert from your local timezone as needed.

## Tools Available in Cron Jobs
`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`

Note: MCP tools (Notion) are NOT available in cron jobs — use direct curl against the Notion REST API if needed.

## Authentication

Cron jobs support two auth methods — controlled by whether `ANTHROPIC_API_KEY` is set in `.env`:

| Method | When | Cost |
|--------|------|------|
| **API key** (recommended for public/shared setups) | `ANTHROPIC_API_KEY` is set in `.env` | Pay-per-token (~$5-15/mo for typical cron volume at sonnet rates) |
| **Consumer subscription** (Max plan) | `ANTHROPIC_API_KEY` is not set | Flat rate via Max subscription |

API key auth is the ToS-compliant path for automated/headless usage. The consumer terms prohibit "automated or non-human means" unless using an API key. If you're running this publicly or sharing the repo, set `ANTHROPIC_API_KEY` in your `.env`.

For personal setups where you're already on a Max plan, consumer auth works fine in practice — Anthropic's enforcement targets third-party harnesses and token resellers, not official CLI automation.

## Gotchas
- **Never use `--append-system-prompt`** to pass secrets or context. Early listener versions leaked tokens to journalctl this way. Current system uses cwd auto-loading of CLAUDE.md.
- **Cron delivery mode:** The legacy "announce" mode resolved via "last" channel. If last was WhatsApp (not configured), it failed silently. Current system uses `[NOTIFY]` marker — no channel resolution issue.
