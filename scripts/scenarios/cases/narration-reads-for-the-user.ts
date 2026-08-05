import { CompanyStatus } from "@/generated/prisma/client";
import {
  narrateCompanyCaughtUp,
  narrateJobClose,
} from "@/server/procedures/registry/walkthrough/narration";

import type { Scenario } from "../lib";

// Narration is pure now — the entity writes return facts and this module turns
// them into the user-facing line. So this asserts the strings directly instead
// of mutating a real row and restoring it, which is what the two scenarios this
// replaced had to do.
const scenario: Scenario = {
  name: "narration-reads-for-the-user",
  cost: "cheap",
  describe:
    "Company/job state-change narration names the entity and carries the shared 'Pulling up what's next.' debrief on company wraps (so the post-action chrome reads consistently with the wrap → picker handoff).",
  async run() {
    const notes: string[] = [];

    const jobLine = narrateJobClose({
      jobTitle: "Senior Software Engineer",
      companyName: "Stripe",
      reason: "NOT_A_MATCH",
    });
    const jobNamesRole = jobLine.includes("Senior Software Engineer");
    const jobNamesCompany = jobLine.includes("@ Stripe");
    notes.push(
      `job close: ${JSON.stringify(jobLine)}`,
      `names the role: ${jobNamesRole}`,
      `names the company: ${jobNamesCompany}`,
    );

    const caughtUp = narrateCompanyCaughtUp({
      companyId: "cmp_test",
      companyName: "Stripe",
      status: CompanyStatus.CAUGHT_UP,
    });
    const caughtUpReads = caughtUp.includes("caught up");
    const hasDebrief = caughtUp.includes("Pulling up what's next");
    notes.push(
      `company caught-up: ${JSON.stringify(caughtUp)}`,
      `reads as caught up: ${caughtUpReads}`,
      `carries the debrief suffix: ${hasDebrief}`,
    );

    // The engagement tail must NOT claim "caught up" when an application is out.
    const inFlight = narrateCompanyCaughtUp({
      companyId: "cmp_test",
      companyName: "Stripe",
      status: CompanyStatus.IN_FLIGHT,
    });
    const inFlightHonest =
      inFlight.includes("in flight") && !inFlight.includes("caught up");
    notes.push(
      `company in-flight: ${JSON.stringify(inFlight)}`,
      `doesn't claim caught up: ${inFlightHonest}`,
    );

    return {
      ok:
        jobNamesRole &&
        jobNamesCompany &&
        caughtUpReads &&
        hasDebrief &&
        inFlightHonest,
      notes,
    };
  },
};

export default scenario;
