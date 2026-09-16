# OpenClaw Starter Kit

A complete, opinionated setup for running a personal AI assistant on your own VPS,
powered by [OpenClaw](https://github.com/openclaw/openclaw) and your **Claude
subscription** (Max/Pro), with an optional multi-agent platform ("Agent Platform V2")
on top.

This is not OpenClaw itself. It is the layer *around* it that normally takes months
of trial and error:

- A **reasoning framework**: standing rules, output style, memory discipline that make
  the assistant behave like a senior operator instead of a chatbot.
- The **LLM Wiki memory system**: 3-layer persistent memory (raw sources, curated wiki
  pages, slim index) with anti-drift rules.
- The **Claude subscription bridge**: run the heavy load through the Claude Code CLI on
  your flat-rate subscription instead of paying per-token API prices.
- **Agent Platform V2**: a self-hosted multi-agent orchestration platform (projects,
  autopilot, approval inbox, stop/resume) that talks to your OpenClaw gateway.

## Quick start

```bash
# 1. Install prerequisites and OpenClaw (interactive)
./scripts/install.sh

# 2. Attach your Claude subscription (requires an active Claude Max/Pro plan)
./scripts/setup-claude-subscription.sh

# 3. Seed your assistant's workspace
cp -r workspace-template/* ~/.openclaw/workspace/

# 4. Start chatting (Telegram or any channel you configured), then let the
#    assistant run its own BOOTSTRAP.md to pick a name and personality.

# 5. (recommended, as root on the host) nightly backup of everything to Google Drive
sudo bash tools/backup-global/install-host.sh --apply --run-now   # see docs/05
```

Then read the docs, in order:

| Doc | What it covers |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | How the pieces fit together |
| [docs/02-claude-subscription.md](docs/02-claude-subscription.md) | The subscription bridge, in depth (footguns included) |
| [docs/03-workspace-framework.md](docs/03-workspace-framework.md) | The reasoning framework and how to customize it |
| [docs/04-memory-system.md](docs/04-memory-system.md) | The LLM Wiki memory pattern |
| [docs/05-backup-google-drive.md](docs/05-backup-google-drive.md) | Nightly encrypted backup of the whole VPS to Google Drive, one-command restore |
| [agent-platform/INSTALL.md](agent-platform/INSTALL.md) | Agent Platform V2 setup |

## What you need

1. A VPS (Ubuntu 22.04+, 4 GB RAM minimum, 8 GB recommended) or any Linux box.
2. Docker + Docker Compose (the installer checks for them).
3. A **Claude subscription** (Max recommended; this is what powers the assistant
   at flat cost). Each user needs their *own* subscription: OAuth tokens are
   personal, tied to your account limits, and sharing them violates Anthropic's ToS.
4. A Telegram bot token (or another OpenClaw-supported channel) to talk to it.
5. Optional: API keys for fallback models (Gemini, DeepSeek, etc.).

## What is deliberately NOT here

- No secrets, tokens, or personal data. Everything sensitive is a placeholder you
  fill in. Run `tools/anon-check.sh` before committing changes if you fork this.
- No OpenClaw source code (install it from the official repo; this kit configures it).

## Layout

```
scripts/               install.sh, setup-claude-subscription.sh
config/                openclaw.json.example (annotated)
workspace-template/    the assistant's home: framework, memory system, skills
agent-platform/        Agent Platform V2 (server + web UI), anonymized
docs/                  the manuals
tools/                 anon-check.sh (secret/PII gate for contributors)
tools/backup-global/   nightly restic backup to Google Drive + restore (host scripts)
```

## License / distribution

Private repo, shared person-to-person. Do not publish without running your own
review pass. OpenClaw itself is licensed under its own terms in its repository.
