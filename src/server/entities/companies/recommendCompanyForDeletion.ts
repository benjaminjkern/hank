import { prisma } from "@/server/db/prisma";

// Flag a GLOBAL Company row for admin review + hard deletion. Does NOT delete —
// sets deletionRecommendedAt + deletionRecommendedReason; the /admin/deletions
// queue reads those and the admin approves (FK-cascade delete: the Company's
// Jobs + JobInteractions + events go with it) or dismisses (clears the flag).
// Re-flagging keeps the original timestamp so the queue order is stable and only
// updates the reason. Distinct from untrack_company (deletes only the current
// user's tracking rows) and close_company (soft skip, audit trail kept). Returns
// the name + wasAlreadyFlagged so the tool can say "flagged" vs "updated
// recommendation", or null when the company row doesn't exist.
export async function recommendCompanyForDeletion({
  companyId,
  reason,
}: {
  companyId: string;
  reason: string;
}): Promise<{ name: string; wasAlreadyFlagged: boolean } | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, deletionRecommendedAt: true },
  });
  if (!company) return null;
  await prisma.company.update({
    where: { id: companyId },
    data: {
      deletionRecommendedAt: company.deletionRecommendedAt ?? new Date(),
      deletionRecommendedReason: reason,
    },
  });
  return {
    name: company.name,
    wasAlreadyFlagged: company.deletionRecommendedAt !== null,
  };
}
