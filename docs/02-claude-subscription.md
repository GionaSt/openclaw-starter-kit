# The Claude subscription bridge (read this whole page)

This is the highest-value, easiest-to-break part of the setup. It was reverse
engineered the hard way; every footgun below actually happened.

## The fundamental fact: two distinct auth systems

OpenClaw can reach Anthropic two completely different ways. Confusing them is the
root of every billing surprise.

### A) cliBackend `claude-cli` — THIS uses your subscription ✅
- Config: `agents.defaults.models["anthropic/<model>"].agentRuntime.id = "claude-cli"`
- Backend: `agents.defaults.cliBackends.claude-cli.command = <path to claude binary>`
- Auth: `agents.defaults.cliBackends.claude-cli.env.CLAUDE_CODE_OAUTH_TOKEN = sk-ant-oat01-...`
- Mechanism: OpenClaw does NOT call the Messages API for these models. It launches
  the `claude` binary (Claude Code CLI) with your subscription OAuth token. The CLI
  authenticates as your plan → cost covered by the subscription.
- Runtime signature: model shows as `claude-cli/<model>`; the process env has
  `CLAUDECODE=1` and NO `ANTHROPIC_API_KEY`.

### B) Messages API + auth.profiles — this costs API credits 💸
- Used by every model WITHOUT `agentRuntime.id = claude-cli`.
- An `api_key` profile (`sk-ant-api03-...`) is real pay-per-token spend.
- A subscription OAuth token (`sk-ant-oat01-...`) does NOT work on the plain
  Messages API endpoint. Don't try: it fails silently into fallbacks.

## Golden rule

Heavy load runs ONLY on models with `agentRuntime.id = "claude-cli"`. If you keep
an API key as a fallback safety net, watch its usage: if it gets used often,
something heavy is falling through to the API and you're paying. Investigate.

## Setup

Run `scripts/setup-claude-subscription.sh`. It runs `claude setup-token` (browser
login with YOUR account), patches the config (merge, with backup), verifies with a
live `claude -p 'PONG'` probe, restarts OpenClaw.

## Diagnosing (in order)

1. `openclaw models status` → auth health, profiles, expiries (local read, 0 tokens).
2. `claude -p 'reply only: PONG'` → PONG + exit 0 = subscription alive.
3. Check the model id at runtime: `claude-cli/<model>` = subscription;
   a plain `anthropic/<model>` on the API path = you're paying.
4. "token present and not expired" ≠ "token authorized". If a profile shows ok but
   never has a lastUsed, it has never actually worked.

## Footguns (all real)

1. **New model newer than your CLI**: update the CLI first
   (`npm i -g @anthropic-ai/claude-code`), test `claude -p --model <id> 'OK'`,
   only then add it to config. A model the CLI doesn't recognize silently falls
   back to the API = spend.
2. **Forgetting `agentRuntime.id`** on a newly added Anthropic model = API spend.
3. **Ghost profile names**: `auth.order` must only reference profiles that exist,
   or routing skips/fails.
4. **429 after hours of heavy use is NOT a breakage**: it's the plan's rolling
   window limit. Token stays valid; it resets by itself. Don't "fix" it.
5. **Config edits**: always inspect + merge, never overwrite the whole
   openclaw.json. OpenClaw keeps `.bak` backups next to the file; `openclaw doctor`
   can repair guided.

## Recovery

- CLI/subscription dead (401/invalid): regenerate the token (`claude setup-token`),
  update `cliBackends.claude-cli.env.CLAUDE_CODE_OAUTH_TOKEN`, `openclaw restart`.
- Everything falling on the API key: verify `agentRuntime.id` is still `claude-cli`
  on your primary models and the backend still has the token.

## Rules of the road

- One subscription = one person. Tokens are personal, draw on personal limits, and
  sharing them violates Anthropic's Terms of Service.
- Never commit a token anywhere. The kit's `tools/anon-check.sh` greps for
  `sk-ant-` as a pre-commit gate.
