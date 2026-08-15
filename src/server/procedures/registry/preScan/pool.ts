// Which roles the metadata pass is allowed to judge, in one place so the
// procedure that runs it and the caller that decides whether to run it can't
// disagree about what's left to do.
//
// NEW alone is not the pool — a role stays NEW through BOTH automatic passes.
// Two extra conditions narrow it:
//   - `preScannedAt: null` — a survivor keeps NEW until the full read moves it
//     on, so the stamp is what stops a scan that dies partway (rate limit,
//     Stop, run cap) from sending the next entry back through verdicts it
//     already made.
//   - unstanced (`agentVerdict`/`userVerdict` null) — a role a pass ruled OUT
//     also keeps NEW: it carries a proposed PASS stance the user can overturn
//     on the board, and the commit is what closes it. Judging it again would
//     re-roll a verdict that's already on the board.

import { JobInteractionStatus } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

export function preScanPoolWhere(): Prisma.JobInteractionWhereInput {
  return {
    status: JobInteractionStatus.NEW,
    preScannedAt: null,
    agentVerdict: null,
    userVerdict: null,
  };
}
