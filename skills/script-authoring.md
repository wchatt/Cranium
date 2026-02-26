# Script Authoring — Writing Reusable Tools

You can write and execute custom scripts. This is a core capability — use it whenever a task requires multi-step logic, data processing, or automation that goes beyond simple tool calls.

## When to Write a Script vs Use Tools Directly
- **Write a script when:** Task has complex logic, loops, data transformation, multiple API calls, or needs error handling. Also when the workflow is likely to be repeated.
- **Use tools directly when:** Simple file reads, single web searches, one-off commands.

## How to Write Scripts
1. **Write** the script to `scripts/` directory
2. **Test** it: `node $CRANIUM_DIR/scripts/my-script.cjs`
3. Use `.cjs` extension (CommonJS) — the project uses `require()` patterns throughout

## Available on the Host
- **Node.js** — full standard library (fs, path, https, child_process, etc.)
- **npm modules** in `$CRANIUM_DIR/node_modules/`: add what you need via `npm install`
- **Shell tools:** curl, wget, git, python3, jq, sed, awk, grep, etc.

## Script Template
```javascript
// scripts/example.cjs
const fs = require("fs");
const https = require("https");
const { execSync } = require("child_process");

// Read files
const data = fs.readFileSync(`${process.env.CRANIUM_DIR || "."}/some-file.json`, "utf-8");

// Make HTTP requests

// Run shell commands
const output = execSync("ls -la reports/", { encoding: "utf-8" });

// Use env vars for secrets (never hardcode)
const apiKey = process.env.MY_API_KEY || (() => { throw new Error('MY_API_KEY not set'); })();

// Write output
fs.writeFileSync("reports/my-output.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: true, file: "reports/my-output.json" }));
```

## Promotion Criteria
A script should live in `scripts/` (permanently) when:
1. It's been used successfully at least once
2. It handles a repeatable workflow (not a one-off)
3. It's general enough to be called from cron jobs, other scripts, or ad-hoc

If a script is truly one-off, write it to `/tmp/` instead.

## Current Promoted Scripts

| Script | Purpose | Used By |
|--------|---------|---------|
| `cognitive-benchmark.cjs` | Brain performance benchmark (test prompts + scoring) | Friday cron |
| `time-tracker.cjs` | Slack-based time tracking (activity windows from user's messages) | Night routine |

Add your own scripts to this table as they get promoted.

## Rules
- **Never hardcode secrets.** Use `process.env.VAR_NAME` and document required env vars.
- **Use absolute paths.** Scripts may run from cron or different working directories.
- **stdin hanging:** When spawning `claude -p` via Node.js, stdin must NOT be piped or it hangs forever. Use `stdio: ["ignore", "pipe", "pipe"]`.
- **Rate limit detection:** Never check `resultText` (stdout) for error strings — only check `stderr`. Stdout may contain valid output that happens to include the word "error".
- **Return JSON on stdout** when the script is meant to be called by other scripts: `{"ok": true, ...}`
- **Document new scripts** by adding them to the table above.
