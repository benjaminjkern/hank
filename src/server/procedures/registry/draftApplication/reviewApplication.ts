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

import type { ReviewFinding } from "@/server/entities/jobs/applicationReview";
import type { RunContext } from "@/server/platform/runContext";
import { procedure } from "@/server/procedures/lib/procedure";

import { critiqueAndReviseForm, type CritiqueStop } from "./critiqueAndRevise";
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
  // Why it stopped — whether it finished or gave up is the thing a reader of
  // the result has no other way to know.
  stop: CritiqueStop;
  failed: boolean;
};

export const runReviewApplication = procedure(
  "review_application",
  async (
    args: RunContext & { sessionId: string; jobId: string },
  ): Promise<ReviewApplicationResult> => {
    const result = await critiqueAndReviseForm(args);
    const review = await persistApplicationReview(
      args.userId,
      args.jobId,
      result,
    );
    return {
      ran: result.ran,
      note: result.note,
      open: review?.open ?? [],
      revisedTargets: result.revisedTargets,
      stop: result.stop,
      failed: result.stop === "error",
    };
  },
);
