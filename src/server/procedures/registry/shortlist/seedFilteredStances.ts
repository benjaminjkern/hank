// Open a board over roles that were ALL ruled out before the ranker saw them.
//
// A round where nothing survives the earlier passes has nothing to rank, and
// without this it produced no board at all — the company just went quiet and
// landed caught-up. From the user's side prescan, scan and shortlist are one
// step, so where the pool happened to empty is an implementation detail and must
// not decide whether they get a screen.
//
// Stancing is what makes that screen editable rather than a receipt: a row is
// "on the board" because it carries a stance, so with none the board reads as
// closed and every row renders un-markable. PASS is the honest stance — it's
// where the filtering put them — and the other two marks are the un-close, same
// as on any normal board's filtered tail.

import { ProposedVerdict } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { closedThisRoundJobIds } from "@/server/entities/jobs/boardStance";
import { nowDate } from "@/utils/now";

export async function seedFilteredStances(args: {
  userId: string;
  companyId: string;
}): Promise<number> {
  const { userId, companyId } = args;
  const jobIds = await closedThisRoundJobIds(userId, companyId);
  if (jobIds.length === 0) return 0;

  // No `agentReason`: a CLOSED row renders its `closeNote`, which whichever pass
  // closed it already wrote. Writing the rationale a second time onto the stance
  // would be two copies of one sentence, drifting the moment either is edited.
  const { count } = await prisma.jobInteraction.updateMany({
    where: {
      userId,
      jobId: { in: jobIds },
      // Only rows with no stance yet — a re-entry must not overwrite a mark the
      // user made and hasn't relayed.
      agentVerdict: null,
      userVerdict: null,
      placementVerdict: null,
    },
    data: {
      agentVerdict: ProposedVerdict.PASS,
      placementVerdict: ProposedVerdict.PASS,
      stanceAt: nowDate(),
    },
  });
  return count;
}
