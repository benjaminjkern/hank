// The chunked runtime-audit Opus loop, per sub-agent operation. For each
// operation we pull its new SubAgentRun rows and feed them to Opus in chunks of
// N runs. Each call judges whether each real response was weird AND whether its
// use-case shape is covered by the operation's static fixtures, then emits a
// forward-summary the next chunk of the same operation reads.
//
// Mirrors scripts/audits/sessions/agent/auditor.ts (cached system prefix, forced
// per-chunk tool, forwardSummary carry, crash-safe onChunkComplete) but keyed
// on operations+runs instead of sessions+turns.

import fs from "fs";
import path from "path";

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
import { describeFixture } from "../fixtureRegistry";

import { OPERATION_PURPOSE } from "./purposes";
import { RUNTIME_CHUNK_TOOLS } from "./schemas";

import type { SubAgentRunRow } from "../driver/loadRuns";
import type { FixtureRegistryEntry } from "../fixtureRegistry";
import type Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-4-8";
// Runs carry full input + output, so a run is heavier than a chat turn — keep
// chunks small so a chunk fits comfortably under the output cap.
export const DEFAULT_CHUNK_SIZE = 12;
const MAX_OUTPUT_TOKENS = 16384;

// Per-run render caps (PROMPT only — storage keeps the full untruncated row).
const INPUT_SYSTEM_CAP = 3000;
const INPUT_USER_CAP = 8000;
const OUTPUT_CAP = 12000;

type FindingKind = "weird_output" | "coverage_gap";

export type RuntimeFinding = {
  runId: string;
  kind: FindingKind;
  severity: AdminNoteSeverity;
  shape: string;
  summary: string;
  context: string;
};

export type OperationAuditResult = {
  operation: string;
  runsAudited: number;
  chunks: number;
  findings: RuntimeFinding[];
  filed: number;
  bumped: number;
  skippedNoSession: number;
  costUsd: number;
};

type RunCtx = {
  client: GraderClient;
  model: string;
  auditUserId: string; // whose token budget the audit's Opus calls bill to
  costUsd: number;
  filed: number;
  bumped: number;
  skippedNoSession: number;
};

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars]`;
}

function asText(v: unknown, cap: number): string {
  if (v == null) return "(none)";
  if (typeof v === "string") return truncate(v, cap);
  try {
    return truncate(JSON.stringify(v, null, 2), cap);
  } catch {
    return truncate(String(v), cap);
  }
}

// Cross-pass disagreement hint for `shortlist_jobs`, computed deterministically
// and handed to the auditor as EVIDENCE — it advises, it doesn't rule.
//
// A `skip` verdict now permanently closes the role, and every candidate the
// ranker sees already carries the scan pass's own verdict. So a STRONG scan
// verdict meeting a `skip` is two passes flatly contradicting each other on the
// same posting: either the scan waved through a role with a hard disqualifier
// (a scan miss) or the ranker closed a genuinely strong role (a ranker error).
// Both are worth an AdminNote and only reading the two reasons can tell them
// apart — hence a hint, not a verdict.
//
// Deliberately narrow: POSSIBLE→skip is a soft verdict meeting a hard one and
// is far too common to mean anything, and a candidate with NO scan verdict
// (~17% of them — the scan never ran on it) can't be a scan miss at all.
function renderCrossPassHint(run: SubAgentRunRow): string | null {
  if (run.operation !== "shortlist_jobs") return null;
  const input = (run.input ?? {}) as { initialUserContent?: unknown };
  const userContent =
    typeof input.initialUserContent === "string"
      ? input.initialUserContent
      : "";
  const output = (run.output ?? {}) as {
    verdicts?: Array<{ verdict?: string; reason?: string }>;
  };
  const verdicts = Array.isArray(output.verdicts) ? output.verdicts : [];
  // Candidates render as "## <n>. <title>" then a "Scan verdict: <BUCKET> …"
  // line, in the same order as `verdicts` — position IS the join key.
  const titles = [...userContent.matchAll(/^## \d+\. (.+)$/gm)].map((m) =>
    m[1].trim(),
  );
  const buckets = [...userContent.matchAll(/^Scan verdict: (\S+)/gm)].map((m) =>
    m[1].replace(/:$/, ""),
  );
  if (buckets.length !== verdicts.length || verdicts.length === 0) return null;

  const conflicts = verdicts
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => buckets[i] === "STRONG" && v.verdict === "skip")
    .map(
      ({ v, i }) =>
        `  - "${titles[i] ?? `candidate ${i + 1}`}": scan said STRONG, ranker skipped → "${v.reason ?? "(no reason given)"}"`,
    );
  if (conflicts.length === 0) return null;

  return [
    `CROSS-PASS DISAGREEMENT (computed, not judged) — ${conflicts.length} role(s) the scan rated STRONG were permanently CLOSED by this run:`,
    ...conflicts,
    "Decide which pass was wrong from the reasons above. A concrete disqualifier the scan should have caught (unworkable location, wrong function, far-off level) is a SCAN miss — file it against the scan pass, shape `scan_miss:<disqualifier>`. A vague or merely-comparative reason means the ranker closed a good role — that's a weird_output on THIS sub-agent. If the skip is well-argued and the scan was simply optimistic, file nothing.",
  ].join("\n");
}

// Render one run as the auditor sees it. `input` is `{ system, initialUserContent }`.
function renderRun(run: SubAgentRunRow, index: number): string {
  const input = (run.input ?? {}) as {
    system?: unknown;
    initialUserContent?: unknown;
  };
  const lines: string[] = [];
  lines.push(`### Run ${index + 1} — id=${run.id}`);
  lines.push(
    `ok=${run.ok} · model=${run.model} · outputSchema=${run.outputSchemaName ?? "(none)"} · turns=${run.turns ?? "?"} · at=${run.createdAt.toISOString()} · user=${run.userId} · session=${run.sessionId ?? "(none)"}`,
  );
  if (run.error) lines.push(`ERROR: ${run.error}`);
  lines.push("");
  lines.push("INPUT.system:");
  lines.push(asText(input.system, INPUT_SYSTEM_CAP));
  lines.push("");
  lines.push("INPUT.initialUserContent:");
  lines.push(asText(input.initialUserContent, INPUT_USER_CAP));
  lines.push("");
  lines.push("OUTPUT (the sub-agent's structured output — judge THIS):");
  lines.push(asText(run.output, OUTPUT_CAP));
  const hint = renderCrossPassHint(run);
  if (hint) {
    lines.push("");
    lines.push(hint);
  }
  return lines.join("\n");
}

function buildSystemPrompt(args: {
  rubricMd: string;
  subAgentsDocMd: string;
  operation: string;
  entry: FixtureRegistryEntry | null;
}): Anthropic.TextBlockParam[] {
  const { operation, entry } = args;
  const purpose =
    OPERATION_PURPOSE[operation] ??
    "(no purpose description on file for this operation)";
  const fixtureLines =
    entry && entry.fixtures.length
      ? entry.fixtures
          .map((f, i) => `  ${i + 1}. ${describeFixture(f)}`)
          .join("\n")
      : "  (NONE — this sub-agent has NO static audit. EVERY distinct real use-case shape here is a coverage gap.)";
  const subAgentName = entry?.subAgentName ?? operation;
  const klass = entry?.klass ?? "(unknown)";

  const staticBlock = [
    "# Your role",
    "You are auditing the REAL production outputs of ONE Hank sub-agent, in chunks of its actual invocations. For each run you see the input we sent and the final structured output the sub-agent returned. You judge two things per run:",
    "  1) WEIRD OUTPUT — was the response wrong, off-target, internally inconsistent, ignoring its input, hallucinated, leaking internal vocabulary, or otherwise degraded?",
    "  2) COVERAGE GAP — is this real use-case shape represented by one of the static fixtures listed below? If not, it's a gap in the TEST suite (regardless of whether the sub-agent handled it well).",
    "",
    "You emit ONE forced `commit_runtime_findings` call per chunk carrying every finding plus a forward-summary the next chunk of this same sub-agent reads.",
    "",
    "Each finding lands as one upsertAdminNote() write. Dedup is by (userId, category, dedupKey). The harness builds the dedupKey from `kind` + `operation` + your `shape` slug — so reuse the SAME shape slug for the same recurring pattern and repeats collapse into one row with a bumped count.",
    "",
    "Be calibrated, not trigger-happy, on weird_output: the sub-agent runs on limited context and declining / hedging can be the RIGHT call. Flag a weird_output only when the output is actually indefensible given its input. Be MORE generous on coverage_gap: if a real shape isn't clearly one of the listed fixtures, file it — a redundant gap is cheap, a blind spot in the test suite is not.",
    "",
    "Never put internal file paths, model ids, or token/cost jargon in summary/context — these render to a human admin.",
    "",
    `# Sub-agent under audit: ${subAgentName}  (operation=\`${operation}\`, class=${klass})`,
    `Purpose: ${purpose}`,
    "",
    "# Static fixtures already testing this sub-agent (the tested use-case shapes)",
    fixtureLines,
    "",
    "# How sub-agents work (background)",
    args.subAgentsDocMd,
    "",
    "# Audit rubric",
    args.rubricMd,
  ].join("\n");

  return [
    {
      type: "text",
      text: staticBlock,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// weird_output → tool_misbehavior; coverage_gap → self_improvement. The kind +
// operation + shape drive the dedupKey (see module header).
function categoryFor(kind: FindingKind): AdminNoteCategory {
  return kind === "weird_output" ? "tool_misbehavior" : "self_improvement";
}
function dedupKeyFor(
  kind: FindingKind,
  operation: string,
  shape: string,
): string {
  const source =
    kind === "weird_output"
      ? "subagent_runtime:weird_output"
      : "subagent_coverage_gap";
  return `${source}:${operation}:${shape}`;
}

async function callModel(args: {
  ctx: RunCtx;
  system: Anthropic.TextBlockParam[];
  userText: string;
  notes: string;
}): Promise<Anthropic.Message> {
  const response = await args.ctx.client.messages.create({
    model: args.ctx.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: args.system,
    tools: RUNTIME_CHUNK_TOOLS,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: args.userText }],
  });
  // On the subscription backend these Opus calls bill to the Claude
  // subscription (no marginal $ and no TokenUsage attribution) — skip the dollar
  // rollup + DB write so the cost dashboard isn't polluted with phantom API
  // spend. On the API backend, track cost + usage exactly as before.
  if (graderBackend() === "api") {
    const u = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    args.ctx.costUsd += costOf({
      model: args.ctx.model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      webSearchRequests: 0,
    });
    await recordUsage({
      userId: args.ctx.auditUserId,
      operation: "subagent_runtime_audit",
      model: args.ctx.model,
      usage: response.usage,
      notes: args.notes,
    });
  }
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
  operation: string,
  f: RuntimeFinding,
  run: SubAgentRunRow | undefined,
  sessionResolver: (userId: string) => Promise<string | null>,
): Promise<void> {
  if (!run) {
    console.warn(`    [skip] finding references unknown runId=${f.runId}`);
    return;
  }
  const sessionId = run.sessionId ?? (await sessionResolver(run.userId));
  if (!sessionId) {
    ctx.skippedNoSession++;
    console.warn(
      `    [skip] no session to anchor finding for run=${run.id} (user=${run.userId}); report-only`,
    );
    return;
  }
  const r = await upsertAdminNote({
    userId: run.userId,
    sessionId,
    category: categoryFor(f.kind),
    severity: f.severity,
    summary: f.summary,
    context: `[sub-agent runtime audit · ${operation} · run=${run.id}]\n${f.context}`,
    dedupKey: dedupKeyFor(f.kind, operation, f.shape),
    // Runtime findings aren't anchored to a specific user turn; let upsert fall
    // back to the session's latest user message.
    messageId: undefined,
  });
  if (r.bumped) ctx.bumped++;
  else ctx.filed++;
  console.log(
    `    [${r.bumped ? "BUMP" : "NEW "}] [${f.severity}] ${f.kind} ${dedupKeyFor(f.kind, operation, f.shape)} @${sessionId}`,
  );
}

export type RunOperationAuditArgs = {
  client: GraderClient;
  model: string;
  auditUserId: string;
  operation: string;
  entry: FixtureRegistryEntry | null;
  runs: SubAgentRunRow[];
  rubricMd: string;
  subAgentsDocMd: string;
  chunkSize: number;
  dryRun: boolean;
  artifactsDir: string;
  sessionResolver: (userId: string) => Promise<string | null>;
  onChunkComplete?: (info: {
    chunkIndex: number;
    lastRunInChunk: SubAgentRunRow;
  }) => void | Promise<void>;
};

export async function runOperationAudit(
  args: RunOperationAuditArgs,
): Promise<OperationAuditResult> {
  const ctx: RunCtx = {
    client: args.client,
    model: args.model,
    auditUserId: args.auditUserId,
    costUsd: 0,
    filed: 0,
    bumped: 0,
    skippedNoSession: 0,
  };
  const system = buildSystemPrompt({
    rubricMd: args.rubricMd,
    subAgentsDocMd: args.subAgentsDocMd,
    operation: args.operation,
    entry: args.entry,
  });
  const runsById = new Map(args.runs.map((r) => [r.id, r]));
  const chunks = chunk(args.runs, args.chunkSize);
  const allFindings: RuntimeFinding[] = [];

  const transcriptPath = path.join(
    args.artifactsDir,
    `${args.operation}.audit.jsonl`,
  );
  fs.mkdirSync(args.artifactsDir, { recursive: true });
  const appendTranscript = (entry: unknown) =>
    fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n");

  let priorForwardSummary: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunkRuns = chunks[i];
    const chunkIndex = i + 1;
    console.log(
      `\n  ── ${args.operation} chunk ${chunkIndex}/${chunks.length} (${chunkRuns.length} run${chunkRuns.length === 1 ? "" : "s"}) ──`,
    );

    const userText = [
      priorForwardSummary
        ? `## What you already found in earlier chunks of this sub-agent\n${priorForwardSummary}\n`
        : `## This is the first chunk for this sub-agent.\n`,
      `## Runs to audit in this chunk (${chunkRuns.length})`,
      chunkRuns.map((r, idx) => renderRun(r, idx)).join("\n\n---\n\n"),
      "\nEmit commit_runtime_findings now: every weird_output and coverage_gap finding for the runs above, plus a forwardSummary for the next chunk.",
    ].join("\n");

    const response = await callModel({
      ctx,
      system,
      userText,
      notes: `op=${args.operation} chunk ${chunkIndex}/${chunks.length} runs=${chunkRuns.length}`,
    });
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "commit_runtime_findings",
    );
    if (!toolUse) {
      const text =
        response.content.find(
          (b): b is Anthropic.TextBlock => b.type === "text",
        )?.text ?? "";
      throw new Error(
        `${args.operation} chunk ${chunkIndex} did not return commit_runtime_findings. Text: ${text.slice(0, 400)}`,
      );
    }
    const input = toolUse.input as {
      findings?: RuntimeFinding[];
      forwardSummary?: string;
    };
    const findings = (input.findings ?? []).filter((f) =>
      runsById.has(f.runId),
    );
    const forwardSummary = input.forwardSummary ?? "(empty)";

    appendTranscript({
      kind: "chunk",
      operation: args.operation,
      chunkIndex,
      findingsCount: findings.length,
      findings,
      forwardSummary,
    });
    console.log(`    ${findings.length} finding(s) emitted`);

    for (const f of findings) {
      allFindings.push(f);
      if (args.dryRun) {
        console.log(
          `    [DRY ] [${f.severity}] ${f.kind} ${dedupKeyFor(f.kind, args.operation, f.shape)} (run ${f.runId})`,
        );
      } else {
        await fileFinding(
          ctx,
          args.operation,
          f,
          runsById.get(f.runId),
          args.sessionResolver,
        );
      }
    }

    priorForwardSummary = forwardSummary;
    if (args.onChunkComplete) {
      await args.onChunkComplete({
        chunkIndex,
        lastRunInChunk: chunkRuns[chunkRuns.length - 1],
      });
    }
  }

  return {
    operation: args.operation,
    runsAudited: args.runs.length,
    chunks: chunks.length,
    findings: allFindings,
    filed: ctx.filed,
    bumped: ctx.bumped,
    skippedNoSession: ctx.skippedNoSession,
    costUsd: ctx.costUsd,
  };
}
