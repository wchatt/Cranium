#!/bin/bash
# Cranium — Interactive setup script
# Run this after cloning to configure your AI agent.

set -euo pipefail

CRANIUM_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "╔══════════════════════════════════════╗"
echo "║         Cranium Setup                ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Check prerequisites ──────────────────────────────────────────────────────
echo "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install it: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found v$(node -v))"
  exit 1
fi
echo "  ✅ Node.js $(node -v)"

# Claude Code CLI
if ! command -v claude &>/dev/null; then
  echo "❌ Claude Code CLI not found."
  echo "   Install: npm install -g @anthropic-ai/claude-code"
  echo "   Then run: claude  (to authenticate)"
  exit 1
fi
echo "  ✅ Claude Code CLI"

# Python 3 (needed for cron notifications)
if command -v python3 &>/dev/null; then
  echo "  ✅ Python 3 (for cron notifications)"
else
  echo "  ⚠️  Python 3 not found — cron job Slack notifications won't work"
  echo "     Install: apt install python3"
fi

echo ""

# ── Slack tokens ─────────────────────────────────────────────────────────────
if [ -f "$CRANIUM_DIR/.env" ]; then
  echo "Found existing .env file."
  read -p "Overwrite it? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Keeping existing .env"
    SKIP_ENV=true
  fi
fi

if [ "${SKIP_ENV:-}" != "true" ]; then
  echo "Enter your Slack tokens (see README for setup instructions):"
  echo ""
  read -p "  Bot Token (xoxb-...): " BOT_TOKEN
  read -p "  App Token (xapp-...): " APP_TOKEN

  if [[ ! "$BOT_TOKEN" =~ ^xoxb- ]]; then
    echo "  ⚠️  Bot token should start with 'xoxb-'"
  fi
  if [[ ! "$APP_TOKEN" =~ ^xapp- ]]; then
    echo "  ⚠️  App token should start with 'xapp-'"
  fi

  cp "$CRANIUM_DIR/.env.example" "$CRANIUM_DIR/.env"
  sed -i "s|xoxb-your-bot-token|$BOT_TOKEN|" "$CRANIUM_DIR/.env"
  sed -i "s|xapp-your-app-token|$APP_TOKEN|" "$CRANIUM_DIR/.env"
  chmod 600 "$CRANIUM_DIR/.env"
  echo "  ✅ .env created (permissions: 600)"
fi

echo ""

# ── Install dependencies ─────────────────────────────────────────────────────
echo "Installing dependencies..."
cd "$CRANIUM_DIR"
npm install --omit=dev 2>&1 | tail -3
echo "  ✅ Dependencies installed"

echo ""

# ── Optional: systemd service ────────────────────────────────────────────────
read -p "Set up systemd service (auto-start on boot)? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  SERVICE_NAME="cranium@$(whoami)"
  SERVICE_FILE="/etc/systemd/system/cranium@.service"

  sudo tee "$SERVICE_FILE" > /dev/null << UNIT
[Unit]
Description=Cranium AI Agent (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
WorkingDirectory=$CRANIUM_DIR
ExecStart=$(which node) $CRANIUM_DIR/cranium.js
Restart=always
RestartSec=5
EnvironmentFile=$CRANIUM_DIR/.env

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl start "$SERVICE_NAME"
  echo "  ✅ Service '$SERVICE_NAME' created and started"

  # Optional: passwordless restart (so Claude can restart itself)
  echo ""
  read -p "Allow Claude to restart itself (passwordless sudo)? (y/N) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    SUDOERS_FILE="/etc/sudoers.d/cranium-$(whoami)"
    sudo tee "$SUDOERS_FILE" > /dev/null << SUDOERS
$(whoami) ALL=(ALL) NOPASSWD: /bin/systemctl restart cranium@$(whoami)
$(whoami) ALL=(ALL) NOPASSWD: /bin/systemctl status cranium@$(whoami)
SUDOERS
    sudo chmod 440 "$SUDOERS_FILE"
    echo "  ✅ Passwordless restart enabled"
  fi
else
  echo "  Skipped. Start manually with: node cranium.js"
fi

echo ""
echo "════════════════════════════════════════"
echo "  Setup complete! Message your bot in Slack."
echo "════════════════════════════════════════"
