// Which roles the full-read scan is allowed to judge, in one place so the
// fan-out, its final sweep, and the walkthrough rung that narrates the funnel
// can't disagree about what's left to read.
//
// NEW alone is not the pool: a role one of the automatic passes ruled OUT stays
// NEW too — it carries a proposed PASS stance the user can overturn on the
// board, and the commit is what closes it. Scanning it would pay to re-read a
// role whose verdict is already on the board. The unstanced conditions mirror
// preScanPoolWhere and shortlistPoolStatusWhere: "no stance" IS "not yet
// judged this round".

import { JobInteractionStatus } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

export function scanPoolWhere(): Prisma.JobInteractionWhereInput {
  return {
    status: JobInteractionStatus.NEW,
    agentVerdict: null,
    userVerdict: null,
  };
}
