import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { currentCaptureContext } from "./captureContext";

import type Anthropic from "@anthropic-ai/sdk";

// Anthropic's usage object can carry several fields (some present only with
// caching or server tools). This is the subset we care about.
type AnthropicUsage = Anthropic.Usage & {
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
};

export type UsageOperation =
  | "chat"
  | "compact_summary"
  | "parse_resume"
  | "scrape_html" // generic-HTML LLM scrape; no code path emits it — kept so old rows resolve
  | "shortlist_jobs"
  | "shortlist_reject_summary" // post-commit sub-agent: synthesizes per-job skip notes + a memory-write decision from shortlist-widget rejections
  | "users_distill" // no code path emits it — superseded by memory_consolidation; kept so old TokenUsage rows resolve
  | "company_hunter" // no code path emits it — predecessor key of company_basic_info; kept for old rows
  | "company_basic_info" // basic-info hunter sub-agent (URL + name + description) for the add-to-watchlist + scrape-jobs-for-company paths
  | "logo_verifier" // logo vision-verifier sub-agent (add_to_watchlist pipeline)
  | "pre_scan_job_batch" // PRE_SCAN pt1 — bulk-skip on metadata (add-to-watchlist + scrape-jobs-for-company paths)
  | "prescan_deep" // PRE_SCAN pt2 company-level deal-breaker check; no code path emits it — kept for old TokenUsage rows
  | "enrich_job" // scan step pass 1 — user-independent enrichment (body → terse summary + scalars), cached on Job
  | "scan_job" // scan step pass 2 — per-user match verdict (summary + thesis → SCANNED bucket / CLOSED)
  | "memory_consolidation" // compaction-time multi-path memory consolidation sub-agent
  | "whats_next" // "what should I do next?" rung-walking sub-agent
  | "application_drafting" // cover-letter / short-answer drafter sub-agent
  | "application_decider" // per-job decider: draft / skip / ask_user verdict per form question + cover letter
  | "application_critic" // post-draft recruiter-lens critic: reviews the whole form (+ resume + sibling apps) for incorrect/contradictory/low-quality answers, feeds revisions back to the drafter
  | "eval_fit" // batch job/company fit-scoring sub-agent
  | "rescan" // scrape-jobs-for-company telemetry key; no code path emits it — kept so old TokenUsage rows resolve
  | "find_companies" // merged grow-the-watchlist sub-agent (thesis + resume + watchlist signal + web_search)
  | "discovery_search" // no code path emits it — merged into find_companies; kept for old TokenUsage rows
  | "profile_enrichment_check" // verdict on whether the profile is enriched enough to leave profile mode (rung 0)
  | "company_suggestions" // no code path emits it — merged into find_companies; kept for old TokenUsage rows
  | "name_extraction" // no code path emits it — the name-list path now goes through create_companies; kept for old rows
  | "qa_audit_persona" // scripts/regression/conversations — Opus persona agent role-playing a user against the live pipeline (harness-side, not a Hank code path)
  | "session_audit" // scripts/audits/sessions — agentic auditor that reviews real chat sessions and files AdminNotes
  | "subagent_runtime_audit"; // scripts/audits/sub-agent-runs — Opus auditor over real SubAgentRun rows (weird-output + fixture-coverage-gap findings)

export async function recordUsage(args: {
  userId: string;
  operation: UsageOperation;
  model: string;
  usage: AnthropicUsage | null | undefined;
  sessionId?: string;
  notes?: string;
  toolName?: string;
  // Which key paid: true = our server key, false = the user's own key. Pass
  // `resolved.billedToServer` from resolveLlmClient. Defaults to true (server)
  // for the handful of callers without a resolver in hand (audit harnesses),
  // which all run on the server key anyway.
  billedToServer?: boolean;
  // Run-tree capture (admin /admin/runs). Main-agent turns pass runId + messageId
  // explicitly (recordUsage runs OUTSIDE the ALS scope, after the turn). Sub-agent
  // per-turn usage passes none — the values are read from the capture context ALS
  // set around the parent tool dispatch, and parentToolUseId marks it a sub-call.
  runId?: string;
  messageId?: string;
  parentToolUseId?: string;
  // Per-turn request params captured for the inspector: model params + the
  // volatile system-prompt pieces (skeleton is deduped into PromptSnapshot).
  requestParams?: Prisma.InputJsonValue;
  systemPromptHash?: string;
}): Promise<void> {
  if (!args.usage) return;
  // Explicit args win; fall back to the capture context in effect (sub-agent
  // per-turn usage inherits its parent tool's runId / message / tool_use).
  const cc = currentCaptureContext();
  const runId = args.runId ?? cc.runId ?? null;
  const messageId = args.messageId ?? cc.messageId ?? null;
  const parentToolUseId = args.parentToolUseId ?? cc.parentToolUseId ?? null;
  try {
    await prisma.tokenUsage.create({
      data: {
        userId: args.userId,
        operation: args.operation,
        model: args.model,
        inputTokens: args.usage.input_tokens ?? 0,
        outputTokens: args.usage.output_tokens ?? 0,
        cacheCreationInputTokens: args.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: args.usage.cache_read_input_tokens ?? 0,
        webSearchRequests: args.usage.server_tool_use?.web_search_requests ?? 0,
        sessionId: args.sessionId,
        notes: args.notes,
        toolName: args.toolName,
        billedToServer: args.billedToServer ?? true,
        runId,
        messageId,
        parentToolUseId,
        requestParams: args.requestParams,
        systemPromptHash: args.systemPromptHash,
      },
    });
  } catch (err) {
    // Never break the request because we couldn't write usage.
    console.warn("[usage] recordUsage failed:", err);
  }
}
