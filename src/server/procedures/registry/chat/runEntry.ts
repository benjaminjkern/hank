// The one router: Entry → the procedure it names. Every entry, whoever queued
// it, runs through here — so "what does a company_walkthrough entry do?" has one
// answer, and a new entry kind is a new case below and nothing else.

import type { Entry, StepArgs, StepOutcome } from "@/server/contracts";
import { runCommitDiscovery } from "@/server/procedures/registry/commitDiscovery";
import { runCompanyWalkthrough } from "@/server/procedures/registry/companyWalkthrough";
import { runFindCompanies } from "@/server/procedures/registry/findCompanies";
import { runShowWhatsNext } from "@/server/procedures/registry/whatsNext";
import { runWorkOnJob } from "@/server/procedures/registry/workOnJob";

import { runHankTurns } from "./hankTurns";

export type EntryArgs = StepArgs & {
  // Something already ran this message — the what's-next chooser cues its
  // switch into profile questions instead of arriving unannounced.
  afterOtherWork: boolean;
  // Where the user's right panel is, as its URL path (see shared/panelUrl.ts).
  // Context for Hank, never state.
  panelPath?: string;
};

export async function runEntry(
  entry: Entry,
  args: EntryArgs,
): Promise<StepOutcome> {
  const { afterOtherWork, panelPath, ...step } = args;
  switch (entry.kind) {
    case "company_walkthrough":
      return await runCompanyWalkthrough({
        ...step,
        companyId: entry.companyId,
        direction: entry.direction,
        continuation: entry.continuation,
        revive: entry.revive,
      });
    case "work_on_job":
      return await runWorkOnJob({
        ...step,
        jobId: entry.jobId,
        freshEntry: entry.freshEntry,
      });
    case "opportunity":
      // A lead has no ladder yet: putting it on screen (done by whoever queued
      // this) is all there is, and the user steers from chat.
      return {};
    case "find_companies":
      return await runFindCompanies({
        ...step,
        direction: entry.direction,
        append: entry.append,
      });
    case "commit_discovery":
      return await runCommitDiscovery(step);
    case "show_whats_next":
      return await runShowWhatsNext({ ...step, afterOtherWork });
    case "hank":
      return await runHankTurns({
        ...step,
        nudge: entry.nudge,
        profileGaps: entry.profileGaps,
        panelPath,
      });
  }
}
