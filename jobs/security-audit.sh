#!/bin/bash
# Security audit — invoked by cron-run.sh
# Focused exclusively on security hardening. Runs on Opus, Mon/Wed/Fri.
# Auto-patches low-risk vulnerabilities. Escalates breaking changes to operator.

CRANIUM_DIR="${CRANIUM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

PROMPT='Run a nightly security audit of this VPS. This is a SECURITY-FOCUSED audit — do not check general health, performance, or optimization (that is handled by the separate nightly self-audit job).

## Audit Checklist

### 1. Secrets & Credential Exposure
- Check file permissions on all sensitive files: .env, sa-key.json, mcp-config.json, sessions.json, any .pem/.key files
- All secrets files MUST be 600 (owner read/write only). Fix any that are not.
- Search the cranium/ directory for accidentally committed secrets, tokens, or API keys in code files (grep for patterns like sk-, xoxb-, shpat_, ghp_, AKIA, etc.)
- Verify .gitignore covers .env, sa-key.json, and other sensitive files

### 2. SSH Hardening
- Read /etc/ssh/sshd_config — verify: PasswordAuthentication no, PermitRootLogin no, MaxAuthTries <= 4, PubkeyAuthentication yes
- Check ~/.ssh/authorized_keys for unexpected keys
- Check permissions on .ssh directories (700) and authorized_keys files (600)

### 3. Network Security
- Run: ss -tlnp — list all listening ports and their processes
- Flag anything unexpected (only expected: sshd on 22, Tailscale/VPN, cranium internals)
- Check UFW status: sudo ufw status verbose
- Verify fail2ban is running and configured: sudo fail2ban-client status, sudo fail2ban-client status sshd

### 4. Auth Log Analysis
- Read recent auth logs: journalctl -u ssh --since "24 hours ago" --no-pager
- Also check /var/log/auth.log (last 200 lines) for failed login attempts, brute force patterns, successful logins from unexpected IPs
- Check sudo usage: grep sudo /var/log/auth.log | tail -20

### 5. File System Security
- Check for world-writable files in cranium/: find $CRANIUM_DIR -perm -o+w -type f
- Check for setuid/setgid binaries that should not be there: find $HOME -perm /6000 -type f 2>/dev/null
- Verify brain directory ownership: everything should be owned by the service user

### 6. Dependency Security
- Run npm audit in $CRANIUM_DIR — check for critical/high vulnerabilities

### 7. Crontab Integrity
- Read current crontab (crontab -l) and compare against the documented jobs in skills/cron-jobs.md
- Flag any entries not documented in the skill file
- Check /etc/cron.d/ and /etc/crontab for unexpected system-level cron entries

### 8. Systemd Service Security
- Read the cranium service file and verify it has not been tampered with
- Check for unexpected systemd services: systemctl list-units --type=service --state=running
- Verify the service runs as the service user, not root

### 9. Process Audit
- Check for unexpected running processes: ps aux
- Flag anything that does not belong to expected services (sshd, tailscaled, fail2ban, cranium, cron, systemd)

### 10. Cloud Service Credential Exposure

Scan Notion, Google Drive, and Slack for accidentally exposed secrets or credentials.

**Notion scan:**
Export env vars first: export $(grep -v "^#" $CRANIUM_DIR/.env | grep -v "^$" | xargs)
Use the Notion API (v2022-06-28, Bearer $NOTION_API_TOKEN) to search for pages containing sensitive patterns:
- Search queries: "shpat_", "sk-", "xoxb-", "xoxp-", "ghp_", "AKIA", "re_", "sk-or-v1", "access_token", "client_secret", "password"
- For each search hit, read the page blocks (GET /v1/blocks/{page_id}/children) and check if any block contains an actual token/key value (not just references like "$SHOPIFY_ACCESS_TOKEN" or task descriptions about rotating keys)
- Flag any page that contains a raw secret value in plaintext — include the page URL

**Slack scan:**
- Use the Slack API to pull recent messages from the DM channel ($SLACK_DM_CHANNEL):
  curl -s "https://slack.com/api/conversations.history?channel=$SLACK_DM_CHANNEL&limit=200" -H "Authorization: Bearer $SLACK_BOT_TOKEN"
- Scan message text for raw secret patterns: shpat_[a-f0-9]{32}, sk-[a-zA-Z0-9]{20,}, xoxb-[0-9]+-[a-zA-Z0-9]+, ghp_[a-zA-Z0-9]{36}, AKIA[A-Z0-9]{16}, re_[a-zA-Z0-9]{20,}
- Exclude context-only mentions (e.g. "rotate the shpat_ token" is fine; a message containing the full token value is not)
- Flag any message containing a plausible raw secret — include a link/timestamp

Report all cloud service findings under a "Cloud Services" section using the same warning/ok format.

### 11. Voice Interface Token Security
- Voice call links use short-lived, single-use tokens generated per "call me" request (10min expiry, consumed on WebSocket connect)
- Token file: voice/.voice-tokens.json — shared between listener (writes) and voice server (reads+consumes)
- Static VOICE_AUTH_TOKEN in .env is kept as emergency fallback only
- CHECK: verify voice/.voice-tokens.json has no expired tokens accumulating (should be auto-pruned on each generation)
- CHECK: verify voice/.voice-tokens.json permissions are 600 or tighter
- CHECK: verify voice server is bound to Tailscale IP (not 0.0.0.0) on port 3100
- CHECK: verify VOICE_AUTH_TOKEN is set in .env as fallback — but flag if it appears in recent Slack messages (would indicate old static-token flow still in use)

## Auto-Fix Rules

**FIX immediately (no-breakage risk):**
- File permissions on secrets files (tighten to 600)
- Directory permissions on .ssh dirs (tighten to 700)
- World-writable files in cranium/ (remove world-write bit)
- npm audit fix (patch-level only, no major/minor bumps)

**ESCALATE to operator (potential breakage):**
- Unexpected SSH keys in authorized_keys
- Unknown listening ports or processes
- Signs of actual compromise (unexpected logins, modified binaries)
- npm vulnerabilities requiring major version bumps
- SSH config changes beyond what is already hardened
- Anything where you are not 100% sure the fix is safe

## Changelog

Append ALL actions taken and findings to `audits/changelog.md` under today'\''s date with the header `## YYYY-MM-DD — Security Audit`. This is the permanent record.

## Output Rules

Do NOT post to Slack (no [NOTIFY]). Stay silent. The morning digest reads the changelog.

Only post [NOTIFY] if there is an ACTIVE SECURITY INCIDENT (unauthorized access, compromised credentials, etc.) — not for routine findings or fixes.'

exec "$CRANIUM_DIR/cron-run.sh" opus "$PROMPT"
