import { prisma } from "@/server/db/prisma";

// Hard-delete THIS user's JobInteraction for a job (its JobEvent timeline
// cascades via the onDelete: Cascade on JobEvent.jobInteraction — no manual
// timeline delete needed). The global Job row stays, so a later scrape of the
// same posting resurfaces it as a fresh NEW row (dedupe key (userId, jobId)).
// The hard-cleanup counterpart to close_job ("added by mistake", "junk from the
// scraper") — close_job keeps the audit trail and is right 95% of the time.
// Returns the job title for the result string, or null when the user never had
// a JobInteraction for this job (so the tool can report a clean not-found).
export async function untrackJob({
  userId,
  jobId,
}: {
  userId: string;
  jobId: string;
}): Promise<{ title: string } | null> {
  const jobInteraction = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: { id: true, job: { select: { title: true } } },
  });
  if (!jobInteraction) return null;
  await prisma.jobInteraction.delete({ where: { id: jobInteraction.id } });
  return { title: jobInteraction.job.title };
}
