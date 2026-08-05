# Grader billing: Anthropic API key vs Claude subscription

The four **grader** agents — the `audits/sessions` **auditor**, the
`audits/sub-agent-runs` **auditor**, the `regression/conversations` **persona
simulator**, and the `regression/sub-agents` **judge** — all run on Opus 4.8. By
default they bill to the Anthropic **API key** (pay-as-you-go). You can instead
bill them to your **Claude subscription** (Max) so they spend tokens you already
pay for.

**Scope — only the graders move.** The product code these harnesses drive stays
on the API key regardless: the `regression/conversations` Hank-under-test
(`runUserMessage` → `resolveLlmClient`) and each sub-agent-under-test. This is
_only_ the Opus 4.8 grader calls.

## How it works

[`scripts/lib/graderLlm.ts`](./graderLlm.ts) picks a backend and hands each
harness a client with the same `messages.create(...)` shape it already uses:

- **`api`** (default): a real `new Anthropic({ apiKey })` — forced `tool_choice`,
  exact usage, `recordUsage` unchanged.
- **`subscription`**: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
  authenticated by a `CLAUDE_CODE_OAUTH_TOKEN`. The SDK's `query()` has no
  forced-`tool_choice` knob, so the grader prompts-for-JSON and parses the reply
  (with one retry) — the sub-agent judge already worked exactly this way. No
  per-token dollar cost is tracked on this path (subscription = no marginal $),
  so `recordUsage` / spend-cap accounting is skipped for grader calls.

Selection: **`subscription` when `CLAUDE_CODE_OAUTH_TOKEN` is set**, else `api`.
Force either way with `AUDIT_LLM_BACKEND=api|subscription`. Every run prints
`[grader] backend=…` so the active rail is visible.

**Grader calls leave no Claude Code conversation behind.** The subscription path
passes `persistSession: false` (→ `--no-session-persistence`), so the SDK
subprocess writes no transcript to `~/.claude/projects/`. Without it every
grader call — dozens per harness run — files a one-shot session that shows up in
`claude --resume` and the IDE conversation list alongside your real ones, and
none of them is ever resumable-in-any-useful-sense. Keep the flag when touching
this call site.

## One-time setup

1. Install the `claude` CLI and log into your Max plan (`claude`, then `/login`).
2. Mint a long-lived subscription token (per Claude Code's auth docs; requires a
   Pro/Max/Team/Enterprise plan, lasts ~1 year):
   ```bash
   claude setup-token
   ```
3. Put it in the environment the harnesses run in — e.g. add to `.env`:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=<token from setup-token>
   ```
   **Leave `ANTHROPIC_API_KEY` set** — Hank-under-test still needs it. The grader
   only strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from _its own_
   Agent-SDK subprocess env, so they can't outrank the OAuth token (Anthropic
   auth precedence is `ANTHROPIC_API_KEY` > `ANTHROPIC_AUTH_TOKEN` >
   `CLAUDE_CODE_OAUTH_TOKEN`). The parent process — and everything in-process,
   including Hank-under-test — keeps using the API key.

## Verify billing

Two harnesses are pure grader spend (they read rows from the DB and audit them —
no product code runs), so they're the clean billing checks: **session-audit**
and the **sub-agent runtime audit**. session-audit is the ready-now one (it
replays existing prod session rows); the runtime audit is equally clean but only
has something to run once its `SubAgentRun` migration is applied to prod and real
runs have been captured. Run a short slice and confirm all three:

- the run prints `[grader] backend=subscription`;
- **no new API spend** in the Anthropic Console, and `pnpm usage` shows no new
  `session_audit` / `subagent_runtime_audit` TokenUsage rows (the subscription
  path skips `recordUsage`);
- your Claude subscription usage ticks up instead.

Rollback is trivial: unset `CLAUDE_CODE_OAUTH_TOKEN` (or set
`AUDIT_LLM_BACKEND=api`) → back to the API path.

**The other two harnesses also run product code that legitimately stays on the
API key** — qa-audit's Hank-under-test and the sub-agent-under-test — so those
runs still show _some_ API spend + `TokenUsage` rows; just not for the grader
(persona rows = `qa_audit_persona`; the judge never wrote usage rows either
way). To smoke them: a single sub-agent audit
`pnpm exec tsx scripts/regression/sub-agents/<name>.ts --live` (`--live` because
`.env` points at the prod DB; pick a fixture that isn't field-pinned to an
exact match, or the judge fast-path skips the LLM), or one short qa-audit
persona (`--persona … --max-turns 3`).

## Tradeoffs

- **Rate limits are the real cost now.** Grader runs draw on the same Max
  weekly / 5-hour limits as your interactive Claude Code work — a full
  session-audit (~228 Opus turns) or qa-audit sweep can eat a meaningful chunk
  and could throttle your interactive use. Watch for `rate_limit` errors.
- **No dollar tracking** on the subscription path (intentional).
- **Determinism:** forced tool calls become prompt-and-parse + one retry. The
  judge always ran this way; the two auditors + persona now do on this path only.
- **Caching:** session-audit's manual 1h `cache_control` is dropped on the
  subscription path — the Agent SDK caches automatically. Under a subscription
  that affects rate-limit consumption, not dollars.
- Requires the `claude` CLI wherever the harness runs, and a plan that includes
  Opus 4.8 (Max does).
