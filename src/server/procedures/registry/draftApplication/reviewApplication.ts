// Read a finished application back on its own — the second entry into this
// procedure, for when the writing has changed since anything last looked at it.
//
// It is the same critique-and-revise loop the drafting pass ends with, entered
// without drafting first. That matters after a user edit: the loop leaves their
// sentences alone (isUserOwned) and reports what it found instead, so "review
// it again" can't turn into "rewrite what I just wrote."
//
// The verdict is not displayed anywhere. It is persisted so a finding can sit
// against the answer it objects to, and RETURNED so whoever asked for the pass
// says what came of it — a page that shows a stored verdict has no way to know
// when it stopped being true.

import type { RunContext } from "@/server/agent/contracts";
import type { ReviewFinding } from "@/server/entities/jobs/applicationReview";

import { critiqueAndReviseForm } from "./critiqueAndRevise";
import { persistApplicationReview } from "./persistApplicationReview";

export type ReviewApplicationResult = {
  // false when there was nothing written to read.
  ran: boolean;
  // The reviewer's line to the user about what's on the page.
  note: string;
  // What it couldn't settle — each needs the person, not another rewrite.
  open: ReviewFinding[];
  // Items it rewrote itself along the way (Hank's own text only).
  revisedTargets: string[];
  failed: boolean;
};

export async function runReviewApplication(
  args: RunContext & { sessionId: string; jobId: string },
  onStatus?: (label: string) => void,
): Promise<ReviewApplicationResult> {
  // Pumped by hand rather than `for await`, which discards a generator's return
  // value — and the return value IS the verdict.
  const loop = critiqueAndReviseForm(args);
  let step = await loop.next();
  while (!step.done) {
    if (step.value.type === "progress") onStatus?.(step.value.label);
    // eslint-disable-next-line no-await-in-loop -- draining a generator: each step is produced by the previous one
    step = await loop.next();
  }
  const review = await persistApplicationReview(
    args.userId,
    args.jobId,
    step.value,
  );
  return {
    ran: step.value.ran,
    note: step.value.note,
    open: review?.open ?? [],
    revisedTargets: step.value.revisedTargets,
    failed: step.value.finalVerdict === "error",
  };
}
