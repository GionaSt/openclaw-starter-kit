# Architecture

```
You (Telegram / any channel)
        │
        ▼
┌────────────────────┐     spawns      ┌──────────────────────────┐
│  OpenClaw Gateway   │───────────────▶│ Claude Code CLI (per turn)│
│  (Docker, VPS)      │                │ auth: YOUR subscription   │
│  sessions, cron,    │                │ OAuth token (flat cost)   │
│  memory, skills     │                └──────────────────────────┘
└─────────┬──────────┘
          │ WebSocket (loopback or paired device)
          ▼
┌────────────────────┐
│ Agent Platform V2   │  optional: multi-agent projects, autopilot,
│ (server + web UI)   │  approval inbox, stop/resume, quality gates
└────────────────────┘
```

## The three layers

1. **OpenClaw** (open source, installed from its own repo) is the runtime: channels,
   sessions, tools, cron, memory search. This kit only *configures* it.

2. **The workspace framework** (`workspace-template/`) is the assistant's
   personality and operating discipline: `AGENTS.md` (operating manual),
   `SOUL.md`/`USER.md`/`IDENTITY.md` (who it is, who you are), standing rules
   (expert posture, no hallucination, literal scope), output style, and the LLM
   Wiki memory system. This is what makes a generic agent feel like a competent
   personal chief-of-staff.

3. **Agent Platform V2** (`agent-platform/`) is an optional self-hosted layer on
   top of the gateway: define *projects*, let an architect agent decompose them
   into tasks, run worker agents with quality gates, approve/reject via an inbox,
   stop/resume live runs. It talks to the gateway over WebSocket.

## Cost model

The whole point of the subscription bridge: everything heavy runs through the
Claude Code CLI authenticated with your Max/Pro plan, so your marginal cost per
token is zero (within plan limits). API keys, if configured at all, are a fallback
safety net only. See [02-claude-subscription.md](02-claude-subscription.md).
