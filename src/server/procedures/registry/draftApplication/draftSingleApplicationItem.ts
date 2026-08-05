// Draft ONE application item (the cover letter or one short-answer question)
// through the drafting sub-agent: load the context, run the drafter, hand back
// the text. The shared core of "run the drafter for one field" — and the ONLY
// caller of applicationDraftingSubAgent, invoked by the
// draft_application_question tool, runDraftApplication's cover-letter +
// per-question branches, and the critique-and-revise loop.
//
// It deliberately stops at "here's the drafted text (or why not)" — persisting
// it is the caller's job because the shape differs: the tool writes one answer
// through `persistApplicationAnswer`, the procedure loop accumulates them into
// the answers array itself. Both mark it `reuse: false` — an agent draft never
// re-enters the drafter's own voice corpus until the user opts it in.

import type { RunContext } from "@/server/agent/contracts";
import { withTraceSpan } from "@/server/platform/trace/span";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  applicationDraftingSubAgent,
  type ApplicationDraftingTask,
} from "@/server/subagents/registry/applicationDrafting";

import { loadApplicationDraftingContext } from "./loadApplicationDraftingContext";

export type DraftApplicationItem =
  { kind: "cover_letter" } | { kind: "question"; text: string };

export type DraftSingleItemResult =
  { ok: true; content: string } | { ok: false; error: string };

type DraftSingleItemArgs = RunContext & {
  sessionId: string;
  jobId: string;
  item: DraftApplicationItem;
  extraContext?: string;
  // Set on a re-draft after the critic flagged issues (critiqueAndRevise.ts).
  revision?: ApplicationDraftingTask["revision"];
};

export async function draftSingleApplicationItem(
  args: DraftSingleItemArgs,
): Promise<DraftSingleItemResult> {
  return await withTraceSpan(
    args.item.kind === "cover_letter"
      ? "draft_cover_letter"
      : "draft_short_answer",
    args.trace,
    (trace) => draftItem({ ...args, trace }),
    (r) => (r.ok ? `${r.content.length} chars` : `failed (${r.error})`),
  );
}

async function draftItem(
  args: DraftSingleItemArgs,
): Promise<DraftSingleItemResult> {
  const loaded = await loadApplicationDraftingContext({
    userId: args.userId,
    jobId: args.jobId,
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const task: ApplicationDraftingTask =
    args.item.kind === "cover_letter"
      ? { fieldType: "cover_letter" }
      : { fieldType: "short_answer", question: args.item.text };

  const r = await runSubAgent(
    applicationDraftingSubAgent,
    {
      ...task,
      extraContext: args.extraContext,
      revision: args.revision,
      context: loaded.context,
    },
    args,
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, content: r.output };
}
