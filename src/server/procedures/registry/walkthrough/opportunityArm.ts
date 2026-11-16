import type { TurnEvent } from "@/server/agent/contracts";
import { streamingProcedure } from "@/server/procedures/lib/procedure";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// This arm is a stub. Hank handles all opportunity-focused chat himself for now
// (his prompt covers OPEN / SCREENING / AWAITING semantics), so this arm returns
// silently rather than duplicating what he says. If it's ever built out, it
// would take the same shape as the company / job arms: deterministic transitions
// between PITCHED jobs, AWAITING follow-ups, and CLOSED wraps.
export const runOpportunityArm = streamingProcedure(
  "opportunity_arm",
  async function* (
    input: WalkthroughArgs & { opportunityId: string },
  ): AsyncGenerator<TurnEvent, WalkthroughResult> {
    const { opportunityId, ...args } = input;
    void opportunityId;
    void args;
    return { wrappedUp: false };
  },
);
