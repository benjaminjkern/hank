// Turn what the critique loop concluded into the row the application page reads.
//
// This is the seam that stops the loop failing open. It ran, it reached a
// verdict, and until now that verdict died in the caller's `for await` — so a
// draft with a known contradiction in it looked exactly like a clean one.
//
// Only BLOCKING findings are carried: those are the factual ones ("the letter
// says NYC, the resume says LA") that a person settles. A polish note that
// survived two rewrites is a matter of taste and doesn't earn a slot on the page.
// A finding with no user-facing wording is dropped rather than shown — the
// writer-facing note reads as an instruction to someone else.

import { prisma } from "@/server/db/prisma";
import {
  COVER_LETTER_ID,
  isCoverLetterTarget,
  questionId,
} from "@/server/entities/jobs/applicationItemId";
import {
  readApplicationReview,
  type ApplicationReview,
  type ReviewFinding,
} from "@/server/entities/jobs/applicationReview";
import type { CritiqueIssue } from "@/server/subagents/registry/applicationCritic";

import type { CritiqueLoopResult } from "./critiqueAndRevise";

// One finding per (item, issue): an issue naming two items is two entries, so
// editing one of them clears that half and leaves the other standing.
function findingsFrom(issues: CritiqueIssue[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const issue of issues) {
    if (issue.severity !== "blocking" || !issue.userNote) continue;
    for (const target of issue.targets) {
      const isCover = isCoverLetterTarget(target);
      out.push({
        itemId: isCover ? COVER_LETTER_ID : questionId(target),
        label: isCover ? "Cover letter" : target,
        note: issue.userNote,
      });
    }
  }
  return out;
}

export async function persistApplicationReview(
  userId: string,
  jobId: string,
  result: CritiqueLoopResult,
): Promise<ApplicationReview | null> {
  // The loop never ran (nothing was drafted), so the previous review — if any —
  // still describes the page.
  if (!result.ran) return null;

  // Findings the user settled but Hank hasn't been told about yet survive a
  // re-review: they're owed to the relay, and this pass says nothing about them.
  const prior = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: { applicationReview: true },
  });

  const open =
    result.finalVerdict === "error"
      ? []
      : findingsFrom(result.unresolvedIssues);
  const review: ApplicationReview = {
    outcome:
      result.finalVerdict === "error"
        ? "error"
        : open.length > 0
          ? "unresolved"
          : "clean",
    open,
    settled:
      readApplicationReview(prior?.applicationReview ?? null)?.settled ?? [],
  };
  await prisma.jobInteraction.update({
    where: { userId_jobId: { userId, jobId } },
    data: { applicationReview: review },
    select: { id: true },
  });
  return review;
}
