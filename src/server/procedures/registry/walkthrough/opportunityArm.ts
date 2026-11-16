import { procedure } from "@/server/procedures/lib/procedure";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// This arm is a stub. Hank handles all opportunity-focused chat himself for now
// (his prompt covers OPEN / SCREENING / AWAITING semantics), so this arm returns
// silently rather than duplicating what he says. If it's ever built out, it
// would take the same shape as the company / job arms: deterministic transitions
// between PITCHED jobs, AWAITING follow-ups, and CLOSED wraps.
export const runOpportunityArm = procedure(
  "opportunity_arm",
  (
    _input: WalkthroughArgs & { opportunityId: string },
  ): Promise<WalkthroughResult> => Promise.resolve({ wrappedUp: false }),
);
