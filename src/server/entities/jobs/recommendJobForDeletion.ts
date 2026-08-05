import { prisma } from "@/server/db/prisma";

// Flag a GLOBAL Job row for admin review + hard deletion. Does NOT delete —
// sets deletionRecommendedAt + deletionRecommendedReason; the /admin/deletions
// queue reads those and the admin approves (FK-cascade delete: JobInteractions +
// events) or dismisses (clears the flag). Re-flagging keeps the original
// timestamp so the queue order is stable and only updates the reason. Distinct
// from untrack_job (deletes only the current user's JobInteraction) and close_job
// (soft skip, audit trail kept). Returns labels for the result string +
// wasAlreadyFlagged so the tool can say "flagged" vs "updated recommendation",
// or null when the job row doesn't exist.
export async function recommendJobForDeletion({
  jobId,
  reason,
}: {
  jobId: string;
  reason: string;
}): Promise<{
  title: string;
  companyLabel: string;
  wasAlreadyFlagged: boolean;
} | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      title: true,
      companyName: true,
      company: { select: { name: true } },
      deletionRecommendedAt: true,
    },
  });
  if (!job) return null;
  await prisma.job.update({
    where: { id: jobId },
    data: {
      deletionRecommendedAt: job.deletionRecommendedAt ?? new Date(),
      deletionRecommendedReason: reason,
    },
  });
  return {
    title: job.title,
    companyLabel: job.company?.name ?? job.companyName ?? "(no company)",
    wasAlreadyFlagged: job.deletionRecommendedAt !== null,
  };
}
