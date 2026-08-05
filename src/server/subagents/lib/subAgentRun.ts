// Persist one row per real sub-agent invocation — the input we sent and the
// structured output we got back.
//
// TokenUsage (src/server/platform/usage/track.ts) records that a sub-agent ran and what
// it cost. This records WHAT it actually returned, which TokenUsage/traces
// never captured (traces hold intermediate read-tool calls only, never the
// output-schema emission). The sub-agent runtime audit
// (scripts/audits/sub-agent-runs/) reads these rows to judge whether a real
// response was weird and whether the usage shape is covered by the static
// fixtures in scripts/regression/sub-agents/.
//
// Written unconditionally (like recordUsage) at the ONE capture chokepoint every
// sub-agent goes through, `runSubAgent`. Full untruncated payloads, no pruning
// (deliberate: the audit wants the real input/output, and rows are cheap
// relative to the LLM spend that produced them). Never throws — a capture
// failure must not break the request.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { currentCaptureContext } from "@/server/platform/usage/captureContext";
import type { UsageOperation } from "@/server/platform/usage/track";

// Derived by `runSubAgent` from whether the run got read tools — the only
// mechanical difference the two "classes" have ever had. Kept as a column
// because the runtime audit joins on it and 4k+ rows already carry it.
type SubAgentRunClass = "judgement" | "transform";

// Strip binary payloads (image / document base64) out of captured input while
// keeping every text block. The runtime auditor reads text, not base64 — and a
// raw PDF/image block would bloat the row with megabytes of unauditable bytes.
// No-op for plain strings and text-only content, so it's safe to apply at every
// capture site (the two vision transforms are the only ones carrying binary).
export function redactCaptureContent(content: unknown): unknown {
  if (typeof content === "string" || content == null) return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        const t = (block as { type: string }).type;
        if (t === "image" || t === "document") {
          return { type: t, _redacted: `${t} bytes omitted from capture` };
        }
      }
      return block;
    });
  }
  return content;
}

type RecordSubAgentRunArgs = {
  userId: string;
  sessionId?: string | null;
  operation: UsageOperation;
  model: string;
  klass: SubAgentRunClass;
  ok: boolean;
  outputSchemaName?: string | null;
  // What was sent to the model. Shape is `{ system, initialUserContent }` — the
  // system prompt and the initial user message/content blocks. Stored as JSON.
  input: unknown;
  // The emitted output schema's payload. Undefined/null on failure.
  output?: unknown;
  error?: string | null;
  turns?: number | null;
  // True only when written by the backfill script (reconstructed from existing
  // rows), false for live captures.
  seeded?: boolean;
};

// Normalize an arbitrary value to something Prisma's Json column accepts. Drops
// undefined/functions/class instances via a JSON round-trip; falls back to a
// marker (never throws) on a circular structure.
function toJson(value: unknown): Prisma.InputJsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  } catch {
    return { unserializable: String(value) };
  }
}

// Harnesses that drive sub-agents over SYNTHETIC or EPHEMERAL data set this so
// their runs don't land in SubAgentRun and get audited as if they were real
// production traffic: scripts/regression/sub-agents (static fixtures) and
// scripts/regression/conversations (throwaway tagged users). The runtime audit + backfill run
// in their own processes without it set, so their explicit seed writes below
// still go through.
function captureDisabled(): boolean {
  return process.env.HANK_DISABLE_SUBAGENT_CAPTURE === "1";
}

export async function recordSubAgentRun(
  args: RecordSubAgentRunArgs,
): Promise<void> {
  if (captureDisabled()) return;
  const hasOutput = args.output !== undefined && args.output !== null;
  // Run-tree linkage (admin /admin/runs): the parent tool dispatch set an ALS
  // capture context around this whole handler, so the sub-agent nests under the
  // exact main-agent tool_use without threading ids through every call site.
  // Empty outside a chat turn (backfill / scripts) — those rows link by session.
  const cc = currentCaptureContext();
  try {
    await prisma.subAgentRun.create({
      data: {
        userId: args.userId,
        sessionId: args.sessionId ?? null,
        operation: args.operation,
        model: args.model,
        class: args.klass,
        ok: args.ok,
        outputSchemaName: args.outputSchemaName ?? null,
        input: toJson(args.input),
        output: hasOutput ? toJson(args.output) : Prisma.DbNull,
        error: args.error ?? null,
        turns: args.turns ?? null,
        seeded: args.seeded ?? false,
        runId: cc.runId ?? null,
        parentMessageId: cc.messageId ?? null,
        parentToolUseId: cc.parentToolUseId ?? null,
      },
    });
  } catch (err) {
    // Never break the request because we couldn't capture a run.
    console.warn("[subAgentRun] recordSubAgentRun failed:", err);
  }
}
