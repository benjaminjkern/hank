// Which roles the metadata pass is allowed to judge, in one place so the
// procedure that runs it and the caller that decides whether to run it can't
// disagree about what's left to do.
//
// NEW alone is not the pool. A role stays NEW after surviving this pass — the
// full read is what moves it on — so "still NEW" covers both arrivals and
// survivors, and a scan that dies partway (rate limit, Stop, run cap) leaves the
// two indistinguishable. Gating on NEW alone sent the next entry back through
// the whole pass, paying for it twice and re-rolling verdicts it had already
// made.

import { JobInteractionStatus } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

export function preScanPoolWhere(): Prisma.JobInteractionWhereInput {
  return { status: JobInteractionStatus.NEW, preScannedAt: null };
}
