#!/usr/bin/env bash
# Attach YOUR Claude subscription (Max/Pro) to OpenClaw.
#
# What this does:
#   1. Checks the Claude Code CLI is installed (installs it if missing).
#   2. Runs `claude setup-token` -> you log in with YOUR Claude account in the
#      browser and get a long-lived OAuth token (sk-ant-oat01-...).
#   3. Patches ~/.openclaw/openclaw.json: sets the claude-cli backend command
#      and CLAUDE_CODE_OAUTH_TOKEN, preserving everything else (merge, no clobber).
#   4. Verifies liveness with `claude -p` and restarts OpenClaw.
#
# NOTE: the token is PERSONAL. It draws on your own plan limits. Never share it,
# never commit it. Each person installs with their own subscription.

set -euo pipefail

OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"

echo "== 1/4 Claude Code CLI =="
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found, installing..."
  npm install -g @anthropic-ai/claude-code
fi
CLAUDE_BIN="$(command -v claude)"
echo "claude binary: $CLAUDE_BIN ($($CLAUDE_BIN --version 2>/dev/null | head -1))"

echo
echo "== 2/4 OAuth token (browser login with YOUR Claude subscription) =="
echo "A URL will appear; open it, log in, paste the code back."
TOKEN_OUTPUT="$($CLAUDE_BIN setup-token 2>&1 | tee /dev/stderr)" || true
TOKEN="$(printf '%s' "$TOKEN_OUTPUT" | grep -oE 'sk-ant-oat01-[A-Za-z0-9_-]+' | tail -1 || true)"
if [ -z "$TOKEN" ]; then
  read -r -p "Could not auto-detect the token. Paste it here (sk-ant-oat01-...): " TOKEN
fi
case "$TOKEN" in
  sk-ant-oat01-*) : ;;
  *) echo "ERROR: that does not look like a subscription OAuth token."; exit 1 ;;
esac

echo
echo "== 3/4 Patching $OPENCLAW_JSON (merge, backup first) =="
[ -f "$OPENCLAW_JSON" ] || { echo "ERROR: $OPENCLAW_JSON not found. Install/onboard OpenClaw first."; exit 1; }
cp "$OPENCLAW_JSON" "$OPENCLAW_JSON.bak.$(date +%Y%m%d%H%M%S)"

CLAUDE_BIN="$CLAUDE_BIN" TOKEN="$TOKEN" OPENCLAW_JSON="$OPENCLAW_JSON" node <<'EOF'
const fs = require('fs');
const path = process.env.OPENCLAW_JSON;
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.agents ??= {}; cfg.agents.defaults ??= {};
const d = cfg.agents.defaults;
d.cliBackends ??= {};
d.cliBackends['claude-cli'] = {
  ...(d.cliBackends['claude-cli'] || {}),
  command: process.env.CLAUDE_BIN,
  env: { ...(d.cliBackends['claude-cli']?.env || {}), CLAUDE_CODE_OAUTH_TOKEN: process.env.TOKEN },
};
d.models ??= {};
for (const id of Object.keys(d.models)) {
  if (id.startsWith('anthropic/') && !id.includes('haiku')) {
    d.models[id].agentRuntime = { id: 'claude-cli' };
  }
}
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('patched: cliBackends.claude-cli + agentRuntime on anthropic models');
EOF

echo
echo "== 4/4 Liveness check + restart =="
if CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" "$CLAUDE_BIN" -p 'reply with exactly: PONG' | grep -q PONG; then
  echo "Subscription OK (PONG)."
else
  echo "WARNING: liveness check failed. Token may be invalid; re-run this script."
  exit 1
fi
openclaw restart || echo "Run 'openclaw restart' manually."
echo
echo "Done. Verify with: openclaw models status"
echo "Runtime signature of subscription use: model shows as claude-cli/<model>, env has CLAUDECODE=1 and NO ANTHROPIC_API_KEY."
