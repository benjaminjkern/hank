// The chunked session-audit Opus loop. One Opus call per chunk of N turns
// (default 50). Each call emits ALL findings for that chunk + a forward
// summary the next chunk reads as "what you knew going in." A final wrap-up
// call sees every chunk's forward summary + the state snapshot and emits
// cross-window findings.
//
// Why chunked: per-turn calls grow conversation history linearly, so cost
// scales quadratically with window length (228 turns / Opus extrapolated to
// ~$700). Chunked, the static reference is cached and each call sends only
// its 50-turn chunk + a tight summary of priors. Same window now costs ~$15.

import fs from "fs";
import path from "path";

import Anthropic from "@anthropic-ai/sdk";

import {
  upsertAdminNote,
  type AdminNoteCategory,
  type AdminNoteSeverity,
} from "@/server/platform/admin/adminNotes";
import { costOf } from "@/server/platform/usage/pricing";
import { recordUsage } from "@/server/platform/usage/track";

import {
  getGraderClient,
  graderBackend,
  type GraderClient,
} from "../../../lib/graderLlm";

import { renderChunkForAuditor, renderWrapUpForAuditor } from "./perception";
import { CHUNK_TOOLS, WRAP_UP_TOOLS } from "./schemas";

import type { AuditTurn } from "../driver/replay";

export const DEFAULT_MODEL = "claude-opus-4-8";
export const DEFAULT_CHUNK_SIZE = 50;
// Bumped from 8192 → 16384 after the first real-data 228-turn run hit
// `stop_reason=max_tokens` on chunk 1 (31 findings + a 2.5KB forwardSummary
// was right at the prior cap). 16K leaves headroom for chunks that file a
// lot AND still need the trailing forwardSummary block to land complete.
const MAX_OUTPUT_TOKENS = 16384;

export type AuditorFinding = {
  category: AdminNoteCategory;
  severity: AdminNoteSeverity;
  summary: string;
  context: string;
  dedupKey: string;
};

export type ChunkResult = {
  chunkIndex: number; // 1-based
  turnRange: { firstTurn: number; lastTurn: number };
  findings: Array<AuditorFinding & { turnIndex: number }>;
  forwardSummary: string;
  costUsd: number;
};

export type WrapUpResult = {
  overallAssessment: string;
  wrapUpFindings: AuditorFinding[];
  costUsd: number;
};

type RunCtx = {
  client: GraderClient;
  model: string;
  userId: string;
  sessionId: string;
  system: Anthropic.TextBlockParam[];
  filed: number;
  bumped: number;
  costUsd: number;
};

function buildSystemPrompt(args: {
  rubricMd: string;
  hankSystemMd: string;
  claudeMd: string;
  existingAdminNotesText: string;
  sessionContextText: string;
}): Anthropic.TextBlockParam[] {
  const staticBlock = [
    "# Your role",
    "You are an auditor reviewing a real Hank chat session in chunks. For each chunk you receive a tight summary of what you knew going in (from prior chunks) plus the full per-turn perceptions for this chunk's turns. You emit ONE forced `commit_chunk_findings` call carrying every finding from this chunk's turns AND a forward-summary memo the next chunk will read.",
    "",
    "Each finding lands as one upsertAdminNote() write on the chunk's return. Dedup is keyed on `(userId, category, dedupKey, dismissed=false)` — if a finding matches an existing dedupKey from the system prompt's existing-AdminNotes list, REUSE the dedupKey verbatim and the upsert bumps occurrenceCount. Different category + same dedupKey creates a parallel row (this is fine — the rubric explains why).",
    "",
    "Thoroughness is the point. The cost of missing a real issue is the bug shipping unchanged into the next session, multiplied by every user who hits it. The cost of a false positive is one row the admin dismisses in two seconds. **Lean toward filing.** If you genuinely can't tell whether something's off, file anyway and the admin sorts it.",
    "",
    "After the final chunk you'll get a wrap-up turn — that's where cross-window patterns and the overall assessment go. For per-chunk passes, focus on what's visible inside the chunk plus what carried forward in the prior summary.",
    "",
    "# Hank's rulebook (the system prompt the live agent was operating under)",
    args.hankSystemMd,
    "",
    "# AGENTS.md (project conventions)",
    args.claudeMd,
    "",
    "# Audit rubric — what counts as a finding, severity guide, dedupKey shape",
    args.rubricMd,
    "",
    "# Session context",
    args.sessionContextText,
    "",
    "# Existing AdminNotes for this session (REUSE these dedupKeys verbatim to bump rather than duplicate)",
    args.existingAdminNotesText,
  ].join("\n");

  return [
    {
      type: "text",
      text: staticBlock,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

async function callModel(args: {
  ctx: RunCtx;
  userText: string;
  tools: Anthropic.Tool[];
  forcedToolName: string;
  notes: string;
}): Promise<Anthropic.Message> {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: args.ctx.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: args.ctx.system,
    tools: args.tools,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: args.userText }],
  };
  const response = await args.ctx.client.messages.create(request);

  // On the subscription backend these calls are billed to the Claude
  // subscription (no marginal $ and no TokenUsage attribution) — skip the
  // dollar rollup + DB write so the cost dashboard isn't polluted with phantom
  // API spend. On the API backend, track cost + usage exactly as before.
  if (graderBackend() === "api") {
    const u = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const turnCost = costOf({
      model: args.ctx.model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      webSearchRequests: 0,
    });
    args.ctx.costUsd += turnCost;
    await recordUsage({
      userId: args.ctx.userId,
      operation: "session_audit",
      model: args.ctx.model,
      usage: response.usage,
      sessionId: args.ctx.sessionId,
      notes: args.notes,
    });
  }

  // Sanity: stop reason should be tool_use if the schema forced it.
  if (
    response.stop_reason !== "tool_use" &&
    response.stop_reason !== "end_turn"
  ) {
    console.warn(
      `  [warn] stop_reason=${response.stop_reason} (expected tool_use)`,
    );
  }
  return response;
}

async function fileFinding(
  ctx: RunCtx,
  f: AuditorFinding,
  messageId: string | null,
): Promise<void> {
  const r = await upsertAdminNote({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    category: f.category,
    severity: f.severity,
    summary: f.summary,
    context: f.context,
    dedupKey: f.dedupKey,
    // Anchor the note at the actual message that generated the finding. Without
    // this, upsertAdminNote falls back to "latest USER message in the session"
    // — correct for the live agent (it files right after that message), but on
    // a historical replay it points EVERY finding at the end of the session.
    // On a dedup-bump the existing row keeps its (earlier) anchor, so a
    // recurring issue stays pinned to where it first surfaced.
    messageId,
  });
  if (r.bumped) ctx.bumped++;
  else ctx.filed++;
  const tag = r.bumped ? "BUMP" : "NEW ";
  console.log(
    `    [${tag}] [${f.severity}] ${f.dedupKey}${messageId ? ` @${messageId}` : ""}`,
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export type RunAuditArgs = {
  userId: string;
  sessionId: string;
  turns: AuditTurn[];
  rubricMd: string;
  hankSystemMd: string;
  claudeMd: string;
  existingAdminNotesText: string;
  sessionContextText: string;
  artifactsDir: string;
  model?: string;
  chunkSize?: number;
  dryRun?: boolean;
  // Called after each chunk's findings are filed, so the caller can advance
  // the cursor crash-safely (next run resumes from chunk boundary).
  onChunkComplete?: (info: {
    chunkIndex: number;
    lastTurnInChunk: AuditTurn;
  }) => void | Promise<void>;
};

export async function runAudit(args: RunAuditArgs): Promise<{
  chunkResults: ChunkResult[];
  wrapUp: WrapUpResult | null;
  filed: number;
  bumped: number;
  costUsd: number;
}> {
  // Grader client: real Anthropic (API key) or the subscription shim (Agent
  // SDK), chosen by graderBackend(). On the subscription path the API key is
  // ignored, so it's fine (not required) for it to be absent here.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = getGraderClient(apiKey ? new Anthropic({ apiKey }) : null);
  const model = args.model ?? DEFAULT_MODEL;
  const chunkSize = args.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const system = buildSystemPrompt({
    rubricMd: args.rubricMd,
    hankSystemMd: args.hankSystemMd,
    claudeMd: args.claudeMd,
    existingAdminNotesText: args.existingAdminNotesText,
    sessionContextText: args.sessionContextText,
  });

  const ctx: RunCtx = {
    client,
    model,
    userId: args.userId,
    sessionId: args.sessionId,
    system,
    filed: 0,
    bumped: 0,
    costUsd: 0,
  };

  const chunks = chunk(args.turns, chunkSize);

  // Map each window-absolute turnIndex → the message to anchor a finding at.
  // Findings reference a turnIndex (the `[Turn N]` header the auditor sees);
  // this turns that into a real, clickable ChatMessage id. Prefer the user
  // message that opened the turn (matches AdminNote.messageId's documented
  // "user's most recent ChatMessage" semantics); fall back to the turn's first
  // assistant message for the rare leading-tail turn that starts mid-assistant.
  const turnAnchor = new Map<number, string | null>();
  for (const t of args.turns) {
    turnAnchor.set(
      t.turnIndex,
      t.userMessageId ?? t.assistantMessageIds[0] ?? null,
    );
  }
  // Cross-window (wrap-up) findings have no single turn — anchor them at the
  // last turn of the window, where the end-state snapshot they reason over was
  // taken. (In practice most wrap-up findings bump a per-turn row and keep its
  // earlier anchor; this only matters for a genuinely new cross-window row.)
  const windowLastTurn = args.turns[args.turns.length - 1];
  const windowEndAnchor = windowLastTurn
    ? (turnAnchor.get(windowLastTurn.turnIndex) ?? null)
    : null;

  const transcriptPath = path.join(
    args.artifactsDir,
    `${args.sessionId}.audit.jsonl`,
  );
  fs.mkdirSync(args.artifactsDir, { recursive: true });
  const appendTranscript = (entry: unknown) => {
    fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n");
  };

  const chunkResults: ChunkResult[] = [];
  const forwardSummaries: string[] = [];
  let priorForwardSummary: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunkTurns = chunks[i];
    const chunkIndex = i + 1;
    const isFinalChunk = i === chunks.length - 1;
    const firstTurn = chunkTurns[0].turnIndex;
    const lastTurn = chunkTurns[chunkTurns.length - 1].turnIndex;
    console.log(
      `\n  ── Chunk ${chunkIndex}/${chunks.length} (turns ${firstTurn}–${lastTurn}, ${chunkTurns.length} turn${chunkTurns.length === 1 ? "" : "s"}) ──`,
    );

    const userText = renderChunkForAuditor({
      chunkIndex,
      totalChunks: chunks.length,
      turns: chunkTurns,
      priorForwardSummary,
      isFinalChunk,
    });

    const response = await callModel({
      ctx,
      userText,
      tools: CHUNK_TOOLS,
      forcedToolName: "commit_chunk_findings",
      notes: `chunk ${chunkIndex}/${chunks.length} turns=${firstTurn}-${lastTurn} count=${chunkTurns.length}`,
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "commit_chunk_findings",
    );
    if (!toolUse) {
      const text =
        response.content.find(
          (b): b is Anthropic.TextBlock => b.type === "text",
        )?.text ?? "";
      throw new Error(
        `Chunk ${chunkIndex} did not return commit_chunk_findings. Text: ${text.slice(0, 500)}`,
      );
    }
    const input = toolUse.input as {
      findings: Array<AuditorFinding & { turnIndex: number }>;
      forwardSummary: string;
    };
    const findings = input.findings ?? [];
    const forwardSummary = input.forwardSummary ?? "(empty)";

    const result: ChunkResult = {
      chunkIndex,
      turnRange: { firstTurn, lastTurn },
      findings,
      forwardSummary,
      costUsd: 0, // recomputed below from ctx delta
    };
    const ctxCostBefore = ctx.costUsd - 0; // tracked below in transcript
    appendTranscript({
      at: new Date().toISOString(),
      kind: "chunk",
      chunkIndex,
      turnRange: result.turnRange,
      findingsCount: findings.length,
      forwardSummary,
      findings,
    });

    console.log(`    ${findings.length} finding(s) emitted`);
    if (!args.dryRun) {
      for (const f of findings)
        await fileFinding(ctx, f, turnAnchor.get(f.turnIndex) ?? null);
    } else {
      for (const f of findings)
        console.log(
          `    [DRY ] [${f.severity}] ${f.dedupKey} (turn ${f.turnIndex} → ${turnAnchor.get(f.turnIndex) ?? "(no msg)"})`,
        );
    }
    // We only learn chunk cost after `callModel` updates ctx.costUsd — fold
    // it in here by diffing against pre-call total. (Simpler: just attribute
    // the total cost rollup at the end.)
    result.costUsd = ctx.costUsd - ctxCostBefore;
    chunkResults.push(result);
    forwardSummaries.push(forwardSummary);
    priorForwardSummary = forwardSummary;

    if (args.onChunkComplete) {
      await args.onChunkComplete({
        chunkIndex,
        lastTurnInChunk: chunkTurns[chunkTurns.length - 1],
      });
    }
  }

  // --- Wrap-up ---
  let wrapUp: WrapUpResult | null = null;
  if (chunks.length > 0) {
    console.log(`\n  ── Wrap-up ──`);
    const wrapUserText = renderWrapUpForAuditor({
      forwardSummaries,
      finalStateSnapshotText: args.sessionContextText,
    });
    const ctxCostBefore = ctx.costUsd;
    const response = await callModel({
      ctx,
      userText: wrapUserText,
      tools: WRAP_UP_TOOLS,
      forcedToolName: "audit_wrap_up",
      notes: `wrap-up chunks=${chunks.length}`,
    });
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "audit_wrap_up",
    );
    if (toolUse) {
      const input = toolUse.input as WrapUpResult;
      wrapUp = {
        overallAssessment: input.overallAssessment ?? "(no assessment emitted)",
        wrapUpFindings: input.wrapUpFindings ?? [],
        costUsd: ctx.costUsd - ctxCostBefore,
      };
      appendTranscript({
        at: new Date().toISOString(),
        kind: "wrap_up",
        overallAssessment: wrapUp.overallAssessment,
        wrapUpFindings: wrapUp.wrapUpFindings,
      });
      console.log(
        `    ${wrapUp.wrapUpFindings.length} cross-window finding(s)`,
      );
      if (!args.dryRun) {
        for (const f of wrapUp.wrapUpFindings)
          await fileFinding(ctx, f, windowEndAnchor);
      } else {
        for (const f of wrapUp.wrapUpFindings)
          console.log(
            `    [DRY ] [${f.severity}] ${f.dedupKey} (wrap-up → ${windowEndAnchor ?? "(no msg)"})`,
          );
      }
    } else {
      const text =
        response.content.find(
          (b): b is Anthropic.TextBlock => b.type === "text",
        )?.text ?? "";
      console.warn(
        `  Wrap-up did not return audit_wrap_up. Text: ${text.slice(0, 300)}`,
      );
    }
  }

  return {
    chunkResults,
    wrapUp,
    filed: ctx.filed,
    bumped: ctx.bumped,
    costUsd: ctx.costUsd,
  };
}
