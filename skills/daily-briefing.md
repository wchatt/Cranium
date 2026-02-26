# Daily Briefing — Morning Context & Priorities

## When to Use
The user says "morning briefing", "what's on today", "brief me", "good morning", or similar. Also runs as a cron job (e.g., 6:00 AM daily).

## The Flow

### 1. Gather Context (silently)
- **Yesterday's daily notes:** Read `memory/YYYY-MM-DD.md` for yesterday — carry-overs, highlights, open threads
- **Today's calendar:** Check for meetings, deadlines, or time-sensitive events
- **Overnight changelog:** Read `audits/changelog.md` for any actions taken by cron jobs overnight
- **Open tasks:** Query Notion (or your task system) for high-priority open items

### 2. Build the Briefing

Post to Slack (or output with `[NOTIFY]` if cron). Three sections:

```
*Morning Briefing — {Month} {Day}*

*Carry-Overs from Yesterday*
→ Unfinished item 1 — brief context
→ Unfinished item 2 — brief context

*Today's Calendar*
→ 10:00 AM — Meeting with X
→ 2:00 PM — Deadline for Y

*Overnight Activity*
→ Summary of what cron jobs did (from changelog)
→ Any issues or alerts that need attention
```

**Rules:**
- Lead with carry-overs — these are the user's first priorities
- Calendar items only if there are any; skip the section if the day is clear
- Overnight activity is a brief summary, not a dump of every log line
- Keep the whole briefing under 15 lines — scannable in 30 seconds
- If nothing notable happened overnight: "Quiet night — all systems nominal."

### 3. Surface Top Priorities
End with a 1-2 sentence recommendation: "Biggest thing on the plate today is X. Suggest starting there."

## Cron Mode
- Uses `[NOTIFY]` to post to Slack
- Runs after all overnight jobs complete (schedule it last in the morning block)
- Compiles the changelog into a human-readable summary instead of raw entries
