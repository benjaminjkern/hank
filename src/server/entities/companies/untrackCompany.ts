import { prisma } from "@/server/db/prisma";

// Hard-delete everything tracking a company FOR THIS USER: the CompanyInteraction
// plus every JobInteraction the user has for that company's jobs (each one's
// JobEvent timeline cascades). The global Company + Job rows stay, so a later
// re-hunt / re-scrape resurfaces the company and its roles as NEW. The
// company-level parity of untrackJob — a true "forget this company for me", not
// a soft close (close_company keeps the audit trail and is right 95% of the
// time). Both deletes run in one $transaction so a mid-call abort (Stop) can't
// strand a company whose jobs were untracked but whose watchlist row survived.
// Returns the company name + how many JobInteractions went with it, or null
// when the company isn't on the user's watchlist.
export async function untrackCompany({
  userId,
  companyId,
}: {
  userId: string;
  companyId: string;
}): Promise<{ name: string; jobsUntracked: number } | null> {
  const companyInteraction = await prisma.companyInteraction.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { company: { select: { name: true } } },
  });
  if (!companyInteraction) return null;
  const companyJobs = await prisma.job.findMany({
    where: { companyId },
    select: { id: true },
  });
  const jobIds = companyJobs.map((j) => j.id);
  const [jobDelete] = await prisma.$transaction([
    prisma.jobInteraction.deleteMany({
      where: { userId, jobId: { in: jobIds } },
    }),
    prisma.companyInteraction.delete({
      where: { userId_companyId: { userId, companyId } },
    }),
  ]);
  return {
    name: companyInteraction.company.name,
    jobsUntracked: jobDelete.count,
  };
}
