# Night Routine — End-of-Day Cleanup & Continuity

## When to Use

**Manual triggers:** The user says "night routine", "close out the day", "end of day cleanup", "wrap up the day", "let's close things out", or similar.

**Automatic fallback:** Cron runs at 11:50 PM. If the routine already ran today (marker exists in daily notes), the cron job skips silently.

## The Flow

### 1. Gather State (do silently)
- **Slack conversation history (PRIMARY SOURCE):** Pull today's messages from the user's DM channel via Slack API (`conversations.history` + `conversations.replies` for each thread). This is the real source of truth — it captures everything that was discussed, decided, and built. The daily notes file only has truncated summaries.
- **Today's daily notes:** Read `memory/YYYY-MM-DD.md` as a supplement — useful for cron job outputs and structured notes that don't go through Slack.
- **Notion tasks (open):** Query Tasks DB for anything with Status != "Completed"
- **Notion tasks (completed today):** Query Tasks DB for Status == "Completed", filter to those with today's `last_edited_time`

**Slack API pattern:**
```bash
# Get today's top-level messages
curl -s "https://slack.com/api/conversations.history?channel=YOUR_CHANNEL_ID&oldest=EPOCH_TIMESTAMP&limit=200" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# Get replies for each thread
curl -s "https://slack.com/api/conversations.replies?channel=YOUR_CHANNEL_ID&ts=THREAD_TS&limit=50" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```
Parse Claude's replies to understand what was actually built/decided in each thread. The user's opening messages tell you the topic; Claude's substantive replies tell you the outcome.

### 2. Reconcile: Completed Work → Notion

For each substantive work item in daily notes:

1. **Check if a matching Notion task exists.** Search open + recently completed tasks by keyword/topic.
2. **If a task exists and is still open → mark it Completed** in Notion.
3. **If a task exists and is already Completed → skip.** No action needed.
4. **If no task exists → try to fold into an existing open task.** Look for a broader task that this work logically falls under. If it fits, update that task's Notes with what was done (and mark Completed if the work fully satisfies it).
5. **If nothing fits → create a new task** marked Completed, with appropriate Project relation and Notes describing what was done.

### 3. Identify Tomorrow's Carry-Overs

Look for tasks that were **created or touched today** but are NOT yet complete. These are things we started or discussed but didn't finish — they're tomorrow's work. Do NOT include the full backlog of old open tasks. Only tasks with activity today.

### 4. Build Time Breakdown

**Run the time tracker script first:**
```bash
node $CRANIUM_DIR/scripts/time-tracker.cjs [YYYY-MM-DD]
```

This script does the heavy lifting deterministically (no AI needed):
- Fetches all Slack threads for the day via API
- Uses thread spans to measure engagement time — from the user's first message to the first bot reply after their last message, plus a 10-min read buffer. This captures reading/reviewing, not just typing, without inflating spans when bot replies come hours later.
- All messages are scoped to the target day — cross-day threads only count the portion within today
- For bot-initiated threads, uses the user's first reply as the engagement start (so a 3 AM cron notification doesn't count until the user responds)
- Merges overlapping thread spans into activity windows (30+ min gap = new window)
- Filters out bot-only threads (no user participation today)
- Outputs structured JSON with activity windows, idle gaps, thread metadata, and opener text

**What Opus does with the script output:**
1. **Label each activity window by project** — Use thread opener text and Notion hints from the JSON to categorize. Map to project names.
2. **Merge windows that belong to the same project** — If two windows are both the same project, combine their minutes.
3. **Write the parenthetical summaries** — Brief description of what happened in each project block.
4. **Generate the bar chart** — Format rules below.

**Categories:** Use project names where possible. Use "Admin/Setup" for morning routine, config changes, task tweaks. Use "Infrastructure" for system/brain work.

**Output format for daily summary:**
```
*Where the Time Went*
██████████░░░░░░ Project A — 3.5h (summary of work)
████░░░░░░░░░░░ Project B — 1.5h (summary of work)
███░░░░░░░░░░░░ Project C — 45m (summary of work)
██░░░░░░░░░░░░░ Project D — 30m (summary of work)
█░░░░░░░░░░░░░░ Admin — 45m (morning routine, config)
```

**Bar chart rules:**
- Bar length is proportional to time spent (longest block = full bar of 15 chars, filled + empty)
- Round to nearest 15 minutes
- Include a parenthetical with what happened in that block
- Sort by time spent, descending
- Only count active time (from the script's `totalActiveMin`)
- State total active hours at the bottom: `*Total active: ~Xh*`

**Weekly rollup (Friday night routine only):**
On Friday, include an additional section after the daily breakdown:

```
*Weekly Time Report — Week of {Mon date}*

*By Project:*
██████████████░ Project A — 8.5h
████████░░░░░░ Project B — 5h
██████░░░░░░░░ Project C — 3.5h
████░░░░░░░░░░ Project D — 2h
██░░░░░░░░░░░░ Admin/Infra — 1h

*Daily rhythm:*
Mon: 6h active | Tue: 7h | Wed: 4h | Thu: 5.5h | Fri: 3h

*Total: ~25.5h active across 5 days*
```

To build the weekly rollup, read the daily notes files for the past 7 days (`memory/YYYY-MM-DD.md`) and pull the time breakdown from each day's End-of-Day Snapshot. This is why the daily time data must also be persisted to the daily notes file (see Step 7).

**After presenting the weekly rollup, append it to `memory/time-log.md`.** This is the durable long-term record — daily notes get pruned after 14 days by the memory audit, but the time log persists forever. Use the format documented at the top of that file. This enables monthly/quarterly trend visibility.

### 5. Write the Summary

Post to Slack (or output with `[NOTIFY]` if cron). Visually appealing, uses emojis. Three sections:

```
*Night Routine — {Month} {Day}*

*Today's Big Wins*
Win 1 — holistic description of what we shipped/accomplished
Win 2 — another major accomplishment
Win 3 — third big thing

*Where the Time Went*
[time bars as described above]

*On Deck for Tomorrow*
→ Task description — brief context on what's left
→ Task description — brief context
```

**Rules:**
- **Big Wins = the top 3 holistic things we shipped today.** Not granular tasks — think "what would I tell someone we got done today?" These are the headline accomplishments.
- **On deck = only tasks created or touched today that aren't finished.** NOT the full backlog. If nothing new is carrying over, say "Clean slate — nothing new carrying over."
- **No Notion task IDs, no project labels, no metadata.** Just human-readable descriptions.
- **Make it feel good to read.** This is the end of the day — the user should see it and think "damn, we got a lot done."
- Keep it scannable. No walls of text.

### 6. Write Completion Marker

Append to today's daily notes (`memory/YYYY-MM-DD.md`):

```
## Night Routine — Completed
```

This marker is checked by the cron fallback to avoid double-runs.

### 7. Update Daily Notes

Add a clean end-of-day snapshot below the marker — highlights, carry-overs, and time breakdown, so tomorrow's morning routine has context. The time breakdown must be persisted here for the Friday weekly rollup to work.

Include in the snapshot:
```
### Time Breakdown
- Project A: 3.5h (summary of work)
- Project B: 1.5h (summary of work)
- Project C: 45m (summary of work)
- Admin: 45m (morning routine, config)
- Total active: ~7h
```

## Task Creation Rules

When creating a new task from today's work:

1. **Always try to fold into an existing task first.** If today's work is part of a broader effort that already has a task, update that task instead of creating a new one.
2. **Only create a new task if nothing existing fits.**
3. **Required fields:** Name, Status (Completed), Priority (infer from context), Project (required — ask if unclear during manual run, use best judgment during cron), Notes (what was done + context).
4. **No Slack permalink needed** for tasks created by night routine — the daily notes serve as the context trail.

## Cron Mode Differences

When running as a cron job (via `jobs/night-routine.sh`):
- **Check for completion marker first.** If `## Night Routine — Completed` exists in today's daily notes, output nothing and exit.
- **Use `[NOTIFY]` prefix** to post the summary to Slack.
- **Don't ask questions.** For ambiguous project associations, use best judgment.
- **MCP tools are NOT available in cron.** Use curl against Notion REST API instead.

## Completion Judgment Rules

When deciding whether a task is "done":
- **If the core deliverable was shipped, mark it Completed.** Don't leave it open because of hypothetical follow-on work. If someone built a system and deployed it, it's done — even if there could theoretically be more to do later.
- **If the task says "build X" and X is built and running, it's Completed.** Don't hold it open because the broader domain isn't "finished." The task was to build the thing, and the thing was built.
- **When in doubt, lean toward Completed.** It's better to close a task and create a new one for follow-up work than to leave a completed task lingering as "In Progress." Lingering tasks that are actually done erode trust in the system.
- **Only leave a task open if there is clearly unfinished work that was part of the original ask.** Not theoretical improvements — actual unfinished deliverables.

## Anti-Patterns
- Don't create tasks for trivial work (config tweaks, typo fixes, routine maintenance)
- Don't be too conservative about marking things complete — if the work shipped, it's done
- Don't reorganize or reprioritize open tasks — this is a cleanup pass, not a planning session
- Don't dump the full open backlog — only show tasks with activity today
- Night routine is about task hygiene + a quick highlight reel, not a comprehensive report
