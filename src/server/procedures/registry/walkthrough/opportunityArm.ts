import type { TurnEvent } from "@/server/agent/contracts";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

// This arm is a stub. Hank handles all opportunity-focused chat himself for now
// (his prompt covers OPEN / SCREENING / AWAITING semantics), so this arm returns
// silently rather than duplicating what he says. If it's ever built out, it
// would take the same shape as the company / job arms: deterministic transitions
// between PITCHED jobs, AWAITING follow-ups, and CLOSED wraps.
export async function* runOpportunityArm(
  opportunityId: string,
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  void opportunityId;
  void args;
  return { wrappedUp: false };
}
