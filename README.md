# Cranium

An AI agent that lives in Slack. You talk to it like a person — it talks back, remembers context, runs scheduled jobs, and can even join voice calls.

Built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and Slack's Socket Mode. No webhooks, no servers to expose, no API gateway.

## What It Does

- **Slack chat** — DM your bot. It uses Claude Code under the hood, so it can read files, run commands, search the web, and use MCP tools. Thread replies maintain conversation context.
- **Persistent memory** — Writes notes to `memory/` files that survive across sessions. It learns your preferences and builds on past work.
- **Skills** — Markdown files in `skills/` that teach the agent how to do specific things (write reports, run audits, manage reminders). Add your own.
- **Scheduled jobs** — Cron-driven scripts in `jobs/` that run Claude on a schedule: morning digests, security audits, memory cleanup.
- **Voice calls** — Say "call me" in Slack and get a browser-based voice link with real-time TTS (Kokoro) and speech recognition.
- **Personality** — `CLAUDE.md` defines how the agent thinks, communicates, and makes decisions. It's meant to be customized.

## Requirements

- **Node.js 18+**
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code` then run `claude` to authenticate
- A **Slack workspace** where you can create apps
- **Python 3** (optional, for cron job Slack notifications)

## Quick Start

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → paste the contents of `slack-app-manifest.json`.

After creating:
- **OAuth & Permissions** → Install to workspace → copy the **Bot Token** (`xoxb-...`)
- **Basic Information** → App-Level Tokens → Generate one with `connections:write` scope → copy the **App Token** (`xapp-...`)

### 2. Clone and Setup

```bash
git clone https://github.com/wchatt/Cranium.git
cd Cranium
bash setup.sh
```

The setup script checks prerequisites, prompts for your Slack tokens, installs dependencies, and optionally creates a systemd service.

Or do it manually:

```bash
cp .env.example .env
# Edit .env with your tokens
chmod 600 .env
npm install --omit=dev
```

### 3. Run

```bash
node cranium.js
```

Or if you set up systemd:

```bash
sudo systemctl start cranium@$(whoami)
```

Message your bot in Slack. It should respond.

## Configuration

Everything is in `.env`:

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot token from your Slack app |
| `SLACK_APP_TOKEN` | Yes | App-level token with `connections:write` |
| `CLAUDE_MODEL` | No | Model for interactive messages (default: `sonnet`) |
| `ANTHROPIC_API_KEY` | No | API key for cron jobs (keeps them off your Max subscription quota) |
| `SLACK_DM_CHANNEL` | No | Channel ID for cron notifications |
| `VOICE_PORT` | No | Voice server port (default: `3100`) |

## Project Structure

```
cranium.js          # Main process — Slack listener + Claude dispatch
CLAUDE.md           # Agent personality, rules, architecture docs
memory/             # Persistent memory files (agent reads/writes these)
skills/             # Skill documents (teach the agent new capabilities)
jobs/               # Cron job scripts (scheduled Claude invocations)
scripts/            # Utility scripts (video processing, benchmarks)
voice/              # Voice call server (TTS + WebSocket + browser UI)
cron-run.sh         # Cron wrapper (handles env, notifications, logging)
setup.sh            # Interactive installer
```

## Cron Jobs

Jobs run Claude on a schedule via `cron-run.sh`. To set them up:

1. Set `ANTHROPIC_API_KEY` and `SLACK_DM_CHANNEL` in `.env`
2. Add entries to your crontab (`crontab -e`):

```cron
0 7 * * * /path/to/Cranium/jobs/morning-digest.sh
0 22 * * * /path/to/Cranium/jobs/night-routine.sh
```

Jobs only post to Slack when their output starts with `[NOTIFY]`. Silent jobs (like security audits) write to `audits/changelog.md` instead.

See `skills/cron-jobs.md` for the full list and schedule.

## Voice Calls

Say "call me" in Slack. The agent starts a local voice server and sends you a browser link. Uses [Kokoro](https://github.com/hexgrad/kokoro) for text-to-speech (downloads a ~530MB model on first use).

Requires the voice server to be reachable from your browser — works on localhost, LAN, or behind a VPN like Tailscale/WireGuard.

## Customization

- **`CLAUDE.md`** — This is the big one. It defines the agent's personality, communication style, autonomy levels, and operational rules. Read through it and make it yours.
- **`memory/MEMORY.md`** — The agent's long-term memory index. It starts with a template; the agent populates it as you interact.
- **`skills/`** — Add new `.md` files here to teach the agent new capabilities. The agent automatically discovers them.

## MCP Tools

Drop an `mcp-config.json` in the repo root and it's auto-detected. Standard [Claude Code MCP format](https://docs.anthropic.com/en/docs/claude-code/mcp).

## How It Works

1. `cranium.js` connects to Slack via Socket Mode
2. When you message the bot, it spawns `claude -p` with your message as the prompt
3. Claude Code runs with full tool access (file I/O, bash, web search, MCP tools)
4. The response streams back to Slack as a thread reply
5. Thread replies use `--resume` to maintain conversation context within a thread
6. The agent reads `CLAUDE.md` and `memory/` files at the start of each session for continuity
