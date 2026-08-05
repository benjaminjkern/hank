import type { LlmModel } from "@/server/platform/llm/models";
import type { Reasoning } from "@/server/platform/llm/reasoning";

// The main chat agent's call parameters — model, cap, and how it reasons. The
// same three a `SubAgentDef` declares, and here for the same reason: these
// belong with the agent's DEFINITION, not with the runtime that executes a turn.
// (agent/runtime/ imports agent/hank/, never the reverse.)

// The model the main chat agent runs on.
//
// Core Hank stays on pro. qa-audit (2026-06-19) showed flash restarts the
// conversation from scratch (re-greets + re-asks already-answered onboarding)
// ~1/3 of the time when runWhatsNext re-enters profile intake mid-session — a
// severe contradiction-class halt on the central chat surface. Two prompt fixes
// (the "Continue the conversation" preamble rule + the mid-conversation banner
// in hank/system.ts) cut it from ~100% to ~33% but couldn't eliminate it: flash
// has no self-verification loop to catch "I just restarted." Pro is clean 1/1
// and never exhibits the failure. The prompt fixes are KEPT (correct regardless
// of model, and they help pro too). This is the one call where flash's
// coherence gap is unfixable by prompt.
export const HANK_MODEL: LlmModel = "deepseek-v4-pro";

// Cap on assistant response tokens per turn. Must stay above the thinking budget
// below — the API requires max_tokens > budget_tokens, strictly.
export const HANK_MAX_TOKENS = 8192;

// Hank is the ONE agent that gets real extended thinking, because he's the one
// call that never forces a tool_choice — thinking is incompatible with forcing,
// which is what pushes every schema-emitting sub-agent onto a scratchpad
// instead. Enabled unconditionally, so it holds for both provider paths. On
// DeepSeek it also fixes the reasoning-leak: a reasoning model with thinking
// force-disabled dumped its reasoning into the visible chat text (2026-06-23).
// The deltas are never streamed to the client — the turn loop yields only
// text_delta — so the reasoning stays internal; the thinking blocks ride in
// final.content for the in-turn tool-loop continuation and are normalized on
// replay by loadSessionMessages.
export const HANK_REASONING: Reasoning = { mode: "thinking", budget: 2048 };
