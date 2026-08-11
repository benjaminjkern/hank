// The walkthrough state machine's I/O contract — what a pass is handed and what
// it reports back. Every file in this folder takes `WalkthroughArgs`; the arms
// return `WalkthroughResult`.

import type { EntryTarget, RunContext } from "@/server/agent/contracts";

export type WalkthroughArgs = RunContext & {
  sessionId: string;
  userMessage: string;
  // The entity to run the arm on this turn — threaded in-memory from the picker
  // dispatch or the handoff tool that just ran (see EntryTarget). Widget-submission
  // entries don't set this — they carry their ids in the submission payload.
  entryTarget?: EntryTarget;
};

export type WalkthroughResult = {
  wrappedUp: boolean;
  // Set when this pass ENDED a company (a close / pause / block / caught-up
  // bundled action ran). The chat runner reads it to run the segment wrap once
  // per message — see procedures/registry/wrapSegment.ts. Deliberately
  // separate from `wrappedUp`: half the paths that set that flag just want the
  // what's-next chooser and must NOT compact (revive declined, a job-gone
  // fallback, the no-target dispatch branch).
  endedCompanyId?: string;
};
