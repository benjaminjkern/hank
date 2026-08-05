# LLM providers (DeepSeek sole, Anthropic vision-only)

Hank runs **every** LLM call — the main chat agent AND all sub-agents — on **DeepSeek** (`deepseek-v4-pro` / `-flash`). DeepSeek exposes an _Anthropic-compatible_ Messages endpoint, so the same `@anthropic-ai/sdk` client talks to it with only `baseURL` + key + model swapped. **Anthropic (Claude) survives only for vision** (résumé parsing + logo verification), which DeepSeek's endpoint can't do.

**There is no provider selection at all.** No per-user toggle, no env override, no capability flag: each call site names one model, and that model's provider serves it. The two vision sub-agents are on Anthropic because they name a Claude model — nothing routes them there.

> The old `User.preferredLlmProvider` toggle column was **dropped** (migration `20260720120000_rename_can_use_server_key`, alongside the `canUseServerKey` rename). The `LLM_PROVIDER_OVERRIDE` and `DEEPSEEK_MODEL_TIER_OVERRIDE` env levers were removed too — both silently substituted a model the call site hadn't asked for, and nothing used them. Don't reintroduce that shape.

## The one rule: go through `resolveLlmClient`

**Every Anthropic/DeepSeek client construction funnels through [`resolveLlmClient(userId, { model })`](../src/server/platform/llm/resolveClient.ts)** (the DeepSeek half — base URL, request normalization — lives beside it in [deepseek.ts](../src/server/platform/llm/deepseek.ts)) — never `new Anthropic({…})` at a call site. It returns `{ client, model, billedToServer }`: the client is pre-configured (right key, right baseURL, DeepSeek request defaults applied), `model` is the id you passed in, handed back so it goes to BOTH `messages.create/stream` AND `recordUsage`, and `billedToServer` (`true` = server key, `false` = user's own key) also threads into `recordUsage` for the admin usage split (see [cost.md](cost.md#server-key-vs-user-key-spend)). The only legitimate `new Anthropic` outside the factory is **key validation** at save time in [settings/actions.ts](../src/app/settings/actions.ts).

```ts
const { client, model } = await resolveLlmClient(userId, { model: MODEL });
```

**The factory answers exactly one question: which key pays for the model you named.** It never picks or substitutes the model. Provider follows from the id via the [`MODELS`](../src/server/platform/llm/models.ts) table, which is a fact about the model, not a policy about the call.

## Two independent axes

Resolution is two orthogonal decisions.

### Axis A — which provider runs this call

Whichever one serves the model the call site named — a lookup in [`MODELS`](../src/server/platform/llm/models.ts), with no policy layer over it. `deepseek-v4-*` → DeepSeek, `claude-*` → Anthropic. The résumé parser and logo verifier name a Claude model because DeepSeek's endpoint rejects image/document content blocks; that is the whole of the "vision carve-out."

`LlmModel` is a closed union of the table's keys, so a typo'd id is a compile error rather than a request that goes to the wrong endpoint with the wrong key.

### Axis B — which key pays for the chosen provider

`resolveAnthropicApiKey` / `resolveDeepseekApiKey` share identical precedence:

1. the user's **own** decrypted key for that provider, if set — **always wins when present; the `canUseServerKey` flag does NOT gate it**;
2. else the **server** key — only if `User.canUseServerKey` is true (**one flag gates BOTH** server keys, `DEEPSEEK_API_KEY` + `ANTHROPIC_API_KEY` — no separate per-provider flag; renamed from the legacy `canUseServerAnthropicKey`);
3. else throw `NoAnthropicKeyError` / `NoDeepseekKeyError` (code `NO_ANTHROPIC_KEY` / `NO_DEEPSEEK_KEY`).

There is **no DeepSeek→Anthropic provider fallback**: a user missing a DeepSeek key gets a hard `NO_DEEPSEEK_KEY`, not a silent Anthropic call. That code flows through `runUserMessage` → the chat route → `apiKeyBlocker` in [chatStore.ts](../src/lib/chatStore.ts) → the blocker modal.

### Key-source matrix

| Call                               | Provider      | Key source (own → server-if-flag → throw)            |
| ---------------------------------- | ------------- | ---------------------------------------------------- |
| Core Hank chat + all subagents     | DeepSeek      | own `DEEPSEEK_API_KEY` → server `DEEPSEEK_API_KEY`   |
| Résumé parse, logo verify (vision) | **Anthropic** | own `ANTHROPIC_API_KEY` → server `ANTHROPIC_API_KEY` |

### The dual-key consequence (onboarding)

**Chat needs a DeepSeek credential; the two vision features need an Anthropic one.** Both degrade gracefully, so onboarding is never hard-blocked past chat:

- Chat runs on DeepSeek. The chat pre-flight ([runUserMessage.ts](../src/server/agent/runtime/runUserMessage.ts)) resolves the DeepSeek key and yields `NO_DEEPSEEK_KEY` if it's absent — this is the **authoritative** first-turn gate. The first-load gate in [page.tsx](../src/app/page.tsx) keys on `hasDeepseekKey || canUseServerKey` (best-effort; it can't see whether `DEEPSEEK_API_KEY` is set in the env, so the runtime gate is the real one).
- Résumé upload without Anthropic → structured `{ ok:false, error }` from the [résumé route](../src/app/api/documents/resume/route.ts); the user just types their background (résumé is optional).
- Logo verify without Anthropic → [logoVerifier.ts](../src/server/subagents/registry/logoVerifier.ts) returns `uncertain` / no write; the UI falls back to the monogram. A vision failure **never** reaches the chat key-blocker (its throws are swallowed / converted to `is_error` tool_results inside the agent loop).

### The key-blocker modal (six reasons, two providers)

[`ApiKeyBlockerModal`](../src/components/ApiKeyBlockerModal.tsx) is paste-fixable for **both** providers. The six `ApiKeyBlockerReason`s ([chatStore.ts](../src/lib/chatStore.ts)):

| SSE code (source)                                  | Reason               | Modal saves      |
| -------------------------------------------------- | -------------------- | ---------------- |
| `NO_DEEPSEEK_KEY` (runUserMessage pre-flight)      | `missing_deepseek`   | DeepSeek key     |
| `INVALID_DEEPSEEK_KEY` (chat route, 401 mid-turn)  | `invalid_deepseek`   | DeepSeek key     |
| `DEEPSEEK_NO_CREDIT` (chat route, 402 / balance)   | `deepseek_no_credit` | DeepSeek key     |
| `NO_ANTHROPIC_KEY` (override pre-flight)            | `missing`            | Anthropic key    |
| `INVALID_ANTHROPIC_KEY` / `ANTHROPIC_NO_CREDIT`    | `invalid` / `no_credit` | Anthropic key |

The mid-turn classifier is `classifyLlmError` in [chat/route.ts](../src/app/api/chat/route.ts): a bare `Anthropic.APIError` reaching the chat catch is a **DeepSeek** error (the main agent is DeepSeek; vision faults can't propagate here), so 401 → `INVALID_DEEPSEEK_KEY`, 402/balance → `DEEPSEEK_NO_CREDIT`. The three Anthropic reasons are unreachable from chat while `HANK_MODEL` names a DeepSeek model; they're kept for the vision surfaces and for that const ever moving.

## The model lives with the sub-agent

**Each call site declares one model, next to the prompt it applies to** — a `const MODEL: LlmModel` at the top of the sub-agent's file, [`HANK_MODEL`](../src/server/agent/hank/call.ts) for the main agent. That model runs, verbatim. It is also **private to the sub-agent** — a procedure that calls one names no model and resolves no client; the template does both. There is no operation→model map, no per-provider fork, and no env lever that swaps it.

```ts
// flash 6/0/0 against rebuilt self-contained fixtures (2026-06-19) — the verdict
// is bounded by the summary + thesis it's handed.
const MODEL: LlmModel = "deepseek-v4-flash";
```

| Model               | Use                                                    |
| ------------------- | ------------------------------------------------------ |
| `deepseek-v4-pro`   | default for anything unaudited                         |
| `deepseek-v4-flash` | ~3× cheaper than pro; sub-agents that pass audit on it |
| `claude-*`          | vision only — see the table in `models.ts`             |

**Governing principle:** flash holds when the task self-verifies (e.g. `company_basic_info`'s URL hunt checks itself via `test_scrape`) or is bounded extraction/gating; use **pro** for grounded generation/coherence with **no self-verification loop** (flash fabricates or restarts the conversation there). Each pin carries its audit history as a comment above the const — read it and re-audit before moving one.

The whole ladder in one command:

```sh
grep -rn -B4 "MODEL: LlmModel" src/server/subagents/registry src/server/agent/hank/call.ts
```

## DeepSeek endpoint quirks (handled in [deepseek.ts](../src/server/platform/llm/deepseek.ts))

- **Thinking is disabled BY DEFAULT; a call site opts in by declaring it.** v4-pro defaults to thinking mode, which rejects a forced `tool_choice` (HTTP 400). Almost everything here forces one, so the factory defaults `thinking: { type: "disabled" }` — but only when the call site hasn't set `thinking` itself (`thinking: body.thinking ?? { type: "disabled" }`). **Who opts in is a declared field, not an inline decision:** [`reasoning`](../src/server/platform/llm/reasoning.ts) — `HANK_REASONING` in [hank/call.ts](../src/server/agent/hank/call.ts) for the main agent, `reasoning` on each `SubAgentDef`. Exactly one thing opts in: the main agent (`budget: 2048`, streamed by `runAgentTurn` with no forced tool_choice — this also fixes the reasoning-leak where a force-disabled reasoning model dumped its reasoning into visible chat). Every sub-agent declares `{mode:"scratchpad"}` and gets a leading private `analysis` field instead — the substitute that works under a forced tool_choice — or, for the two pure extractions, `{mode:"none"}`. See [sub-agents.md → How a sub-agent reasons](sub-agents.md).
- **A forced `tool_choice` is intermittently IGNORED** — DeepSeek sometimes returns text or a read-tool call instead of the named tool, where Anthropic always honors it. This was the sole cause of every prod sub-agent `"exhausted N turns"` failure. **Mitigation lives in the sub-agent harness, NOT the request defaults:** [`runSubAgent`](../src/server/subagents/lib/runSubAgent.ts) retries the forced-final `tool_choice` `forceOutputAttempts` times (default 3) before giving up. See [sub-agents.md](sub-agents.md#the-tool-loop-judgement-contract).
- **`max_tokens` is doubled** (capped at v4-pro's 384k ceiling). Non-thinking v4-pro emits larger tool payloads and was truncating against Claude-sized caps. Billed per actual output token, so the higher cap only costs more when needed.
- **`cache_control` is silently ignored** (DeepSeek auto-caches by prefix). Our sub-agent cache markers no-op — harmless.
- **Mid-array `role:"system"` messages are accepted** (verified against the live API) — this is why UI-provenance replay notes ride a `role:"system"` message (see [uiProvenance.ts](../src/server/agent/session/uiProvenance.ts)).
- **Web search:** DeepSeek advertises `server_tool_use` + `web_search_tool_result`, so `find_companies`'s web search works (bills as tokens, not per-request).

## Cost

DeepSeek prices live in [pricing.ts](../src/server/platform/usage/pricing.ts) (`deepseek-v4-pro` / `-flash`). Rough ladder: v4-pro ≈ 7–18× cheaper than Sonnet; v4-flash ≈ 3× cheaper again than pro. Because the factory returns the DeepSeek id, `recordUsage` / `pnpm usage` / the cost dashboard attribute correctly. See [cost.md](cost.md).

## Settings & audit affordances

- **User-facing:** [settings/SettingsView.tsx](../src/app/settings/SettingsView.tsx) + [actions.ts](../src/app/settings/actions.ts) — a **DeepSeek** key panel (primary, required for chat) and an **Anthropic** key panel (labeled vision-only). Both save/clear with a live validation call (low-balance detected via a `/balance|insufficient/i` match on DeepSeek, `/credit balance/i` on Anthropic). There is no longer a provider toggle.
- **Harness:** nothing to configure. [qa-audit](../scripts/regression/conversations/run.ts) and the [sub-agent audits](../scripts/regression/sub-agents/run-all.ts) run each sub-agent on the model it declares, so they always grade what prod runs; both need `DEEPSEEK_API_KEY` for the code under test plus `ANTHROPIC_API_KEY` for the Opus judge/persona (whose clients don't go through the factory). The old `--deepseek` flags are gone with the env override they set. To A/B a tuned prompt flash-vs-pro, edit that sub-agent's `MODEL` const — it's a one-line diff, and the audit then grades the pin you'd actually ship.
