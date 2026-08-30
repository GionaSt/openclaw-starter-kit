# The workspace framework (how the assistant "reasons")

The assistant's behavior is not magic: it's a small set of markdown files loaded
every session, in a deliberate order. Edit them and behavior changes immediately.

## Load order and roles

| File | Role | Size discipline |
|---|---|---|
| `AGENTS.md` | Operating manual: startup ritual, memory rules, red lines, group-chat etiquette, heartbeat policy | stable, rarely edited |
| `SOUL.md` | Personality: vibe, reasoning style, autonomy level | tiny |
| `USER.md` | Who you are: context, projects, hard preferences | one screen |
| `IDENTITY.md` | Name/emoji/avatar | tiny |
| `MEMORY.md` | Index of long-term memory (main session only) | <15k chars, HARD |
| `memory/standing-rules.md` | The behavior contract (see below) | stable |
| `memory/output-style.md` | The 10 output rules | stable |
| `TOOLS.md` | Environment specifics (SSH hosts, devices, quirks) | grows slowly |
| `HEARTBEAT.md` | Checklist for proactive polls | tiny |

## The behavior contract, in short

1. **Expert posture**: top-expert depth on every topic, hidden-problem hunting,
   out-of-the-box proposals.
2. **Truth-first**: uncomfortable truths stated plainly; the human's final call is
   then executed without sulking.
3. **No hallucination**: "I don't have data on this" is always an acceptable answer;
   invented facts never are.
4. **Verifiability**: every researched claim ships with source link + original quote.
5. **Literal scope**: tasks executed to the letter; no unrequested "improvements".
   Scope creep costs double (build it, then tear it down).
6. **Compressed internal reasoning**: telegraphic chain-of-thought to save tokens,
   never shown to the human; final answers in clean natural language.
7. **Action-first output**: the 10 rules in `memory/output-style.md` (first line =
   next action, numbered steps, no preambles, visible progress).

## Customizing

- Change the *voice* → `SOUL.md`.
- Change *your* context → `USER.md` (keep it one screen; details go in memory pages).
- Change behavior rules → `memory/standing-rules.md` and `memory/output-style.md`.
- Add environment facts → `TOOLS.md`.
- Everything else the assistant learns should flow into the memory wiki
  ([04-memory-system.md](04-memory-system.md)), not into these bootstrap files:
  they are loaded every session, so every byte here is a recurring token cost.

## Skills

Reusable procedures live in `skills/<name>/SKILL.md` in the workspace. OpenClaw
ships many general-purpose skills already; add your own for anything you do
repeatedly (report formats, deploy procedures, domain playbooks). The included
`skills/README.md` shows the minimal skeleton.
