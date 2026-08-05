// Attach contacts to an Opportunity's additional-contacts list. Idempotent
// (skips rows that already exist), so it's safe to re-run. Shared by the
// attach_contact_to_opportunity tool and createOpportunities' seed links. Works
// purely in ids.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

export async function linkContactsToOpportunity(args: {
  opportunityId: string;
  contactIds: string[];
  db?: Prisma.TransactionClient;
}): Promise<void> {
  const unique = [...new Set(args.contactIds)];
  if (unique.length === 0) return;
  const db = args.db ?? prisma;
  await db.opportunityContact.createMany({
    data: unique.map((contactId) => ({
      opportunityId: args.opportunityId,
      contactId,
    })),
    skipDuplicates: true,
  });
}
