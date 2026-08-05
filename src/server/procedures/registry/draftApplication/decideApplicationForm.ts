// Step 2 of the draft-application chain: decide draft / skip / ask_user for
// every item on a job's application form.
//
// Three parts, in order — only the middle one is an LLM call:
//   1. Partition the form (partitionApplicationForm), pre-skipping the fields
//      that have no prose answer by construction.
//   2. Ask the decider sub-agent about what's left, if anything is.
//   3. Merge the two halves into the persisted ApplicationDecision.

import type { RunContext } from "@/server/agent/contracts";
import { loadMergedQuestions } from "@/server/entities/jobs/applicationQuestions";
import { withTraceSpan } from "@/server/platform/trace/span";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import {
  applicationDeciderSubAgent,
  type ApplicationDecision,
} from "@/server/subagents/registry/applicationDecider";

import {
  loadApplicationDeciderInput,
  partitionApplicationForm,
} from "./loadApplicationDeciderInput";

export type DecideApplicationFormResult =
  { ok: true; decision: ApplicationDecision } | { ok: false; error: string };

export async function decideApplicationForm(
  args: RunContext & { sessionId: string; jobId: string },
): Promise<DecideApplicationFormResult> {
  return await withTraceSpan(
    "decide_application_form",
    args.trace,
    (trace) => decideForm({ ...args, trace }),
    (r) =>
      r.ok
        ? `${r.decision.questions.length} question verdict${r.decision.questions.length === 1 ? "" : "s"}`
        : r.error,
  );
}

async function decideForm(
  args: RunContext & { sessionId: string; jobId: string },
): Promise<DecideApplicationFormResult> {
  // The scraped form merged with the per-user hand-added overlay, so a question
  // Hank couldn't scrape but the user described still gets a verdict.
  const merged = await loadMergedQuestions(args.jobId);
  const { draftable, stockDecisions } = partitionApplicationForm(merged.merged);

  // Nothing left for the LLM to weigh in on — return the structured skips
  // directly (also covers the no-questions / cover-letter-only-but-absent case).
  if (draftable.length === 0 && !merged.formWantsCoverLetter) {
    return {
      ok: true,
      decision: {
        questions: stockDecisions,
        coverLetter: null,
        notice: null,
        decidedAt: new Date().toISOString(),
      },
    };
  }

  const loaded = await loadApplicationDeciderInput({
    userId: args.userId,
    jobId: args.jobId,
    draftable,
    allQuestions: merged.merged,
    formWantsCoverLetter: merged.formWantsCoverLetter,
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const result = await runSubAgent(
    applicationDeciderSubAgent,
    loaded.input,
    args,
  );
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    decision: {
      questions: [...stockDecisions, ...result.output.questions],
      coverLetter: result.output.coverLetter,
      notice: result.output.notice,
      decidedAt: new Date().toISOString(),
    },
  };
}
