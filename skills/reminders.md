# Reminders Skill

Send one-shot Slack reminders to the user at a specific time using `at`.

## When to Use
Use for any one-time or scheduled reminder request: "remind me at X to Y", "set a reminder for X", "don't let me forget to Y at X". Use `at` for one-shot reminders, cron for recurring ones.

## How It Works
1. Parse the time and message from the user's request
2. Convert to UTC (adjust for the user's local timezone)
3. Schedule with `at`, baking in env vars at schedule time
4. Confirm to the user with the local time

## The Pattern

```bash
source $CRANIUM_DIR/.env && cat <<ATJOB | at HH:MM UTC
curl -s -X POST \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"'"$SLACK_DM_CHANNEL"'","text":"Reminder: YOUR MESSAGE HERE"}' \
  https://slack.com/api/chat.postMessage
ATJOB
```

**Critical:** Source .env BEFORE the heredoc so vars expand into the job. Single-quoting the heredoc delimiter (ATJOB) would prevent expansion — don't do that.

## Time Conversion
- Check the user's configured timezone in CLAUDE.md or .env
- When in doubt, check: `date` shows current UTC offset

## Verification
Always verify after scheduling:
```bash
at -c <job_number> | tail -5
```
Confirm the token and channel are baked in (not empty strings).

## Managing Jobs
- List: `atq`
- Remove: `atrm <job_number>`
- Inspect: `at -c <job_number>`

## Recurring Reminders
For daily/weekly recurring reminders, use crontab instead:
```bash
crontab -e
# Example: every weekday at 6 PM local (adjust UTC offset)
0 23 * * 1-5 curl -s -X POST -H "Authorization: Bearer TOKEN" ...
```
For recurring, hardcode the token (grab from .env first) since cron doesn't source .env.

## Edge Cases
- **"6:45"** with no AM/PM — ask the user to clarify if ambiguous
- **Next-day times** — `at` defaults to today; if the time has passed, it schedules for tomorrow automatically
- **Emoji in messages** — works fine in the JSON text field
