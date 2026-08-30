#!/usr/bin/env bash
# OpenClaw Starter Kit installer (Ubuntu/Debian).
# Idempotent: safe to re-run. Installs prerequisites, OpenClaw, and seeds the workspace.

set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Prerequisites =="
command -v docker >/dev/null 2>&1 || { echo "Docker missing. Install: https://docs.docker.com/engine/install/"; exit 1; }
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 22 ]; then
  echo "Node.js >= 22 required. Install via https://github.com/nvm-sh/nvm then re-run."
  exit 1
fi
echo "docker + node OK"

echo
echo "== OpenClaw =="
if ! command -v openclaw >/dev/null 2>&1; then
  npm install -g openclaw
fi
openclaw --version

echo
echo "== Onboarding (channels, basic config) =="
if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
  echo "Running interactive onboarding: pick your channel (Telegram is the simplest),"
  echo "paste your bot token when asked."
  openclaw onboard
else
  echo "Existing config found, skipping onboarding."
fi

echo
echo "== Config template =="
echo "Now MERGE the relevant sections of config/openclaw.json.example into"
echo "~/.openclaw/openclaw.json (models, cliBackends, agents.defaults)."
echo "Do NOT overwrite the whole file: your onboarding already wrote channel config."

echo
echo "== Workspace framework =="
WS="$HOME/.openclaw/workspace"
mkdir -p "$WS"
if [ ! -f "$WS/AGENTS.md" ]; then
  cp -rv "$KIT_DIR/workspace-template/." "$WS/"
  echo "Workspace seeded. First chat with the bot will run BOOTSTRAP.md."
else
  echo "Workspace already has AGENTS.md; not overwriting. Copy files manually if desired."
fi

echo
echo "== Next steps =="
echo "1. ./scripts/setup-claude-subscription.sh   (attach YOUR Claude plan)"
echo "2. openclaw restart"
echo "3. Message your bot. It will bootstrap itself."
echo "4. Optional: agent-platform/INSTALL.md for the multi-agent platform."
