import { prisma } from "@/server/db/prisma";
import { JobInteractionStatus } from "@/server/generated/prisma/client";
import { runWalkthrough } from "@/server/procedures/registry/walkthrough";

import { isUserAbortError } from "@/shared/utils/abort";

import { SESSION_ID, USER_ID, recordInto, withFocus } from "../lib";

import type { EventRecord, Scenario } from "../lib";

const scenario: Scenario = {
  name: "defensive-guard-narrates-stale-job",
  cost: "cheap",
  describe:
    "When the state machine's runJobArm finds a focused job that's no longer SHORTLISTED (terminal status), it must narrate 'no longer shortlisted' BEFORE clearing focus + re-dispatching. Catches the silent-focus-correction class.",
  async run() {
    const notes: string[] = [];
    const target = await prisma.jobInteraction.findFirst({
      where: { userId: USER_ID, status: JobInteractionStatus.APPLIED },
      select: { jobId: true, job: { select: { companyId: true } } },
    });
    if (!target?.job.companyId) {
      return {
        ok: true,
        notes,
        skipped: "no APPLIED job with companyId on the user",
      };
    }
    const result = await withFocus(
      {
        focusedCompanyId: null,
        focusedJobId: target.jobId,
        focusedOpportunityId: null,
      },
      async () => {
        const events: EventRecord[] = [];
        // Stop the run once the guard narration lands (or after 8 events): the
        // state machine may re-dispatch into runCompanyArm next, and that
        // recovery is not what this scenario is about.
        const stop = new AbortController();
        const record = recordInto(events);
        await runWalkthrough({
          userId: USER_ID,
          sessionId: SESSION_ID,
          userMessage: "",
          // Focus is ephemeral — dispatch runs off the threaded entry target,
          // not the slot. (withFocus still sets the slot but it's now ignored.)
          entryTarget: { kind: "job", id: target.jobId },
          signal: stop.signal,
          say: async (ev) => {
            // Halt the run at its next narration, the way returning from the
            // old generator did.
            if (stop.signal.aborted) {
              throw new DOMException("scenario stopped", "AbortError");
            }
            await record(ev);
            const guardSaid =
              ev.type === "pipeline_status" &&
              /no longer shortlisted/i.test(ev.text);
            if (guardSaid || events.length >= 8) stop.abort();
          },
        }).catch((err: unknown) => {
          if (!isUserAbortError(err)) throw err;
        });
        return events;
      },
    );
    const guardLine = result.find(
      (e) =>
        e.type === "pipeline_status" &&
        /no longer shortlisted/i.test(e.text ?? ""),
    );
    notes.push(
      `total events captured: ${result.length}`,
      `guard line found: ${!!guardLine}`,
      ...(guardLine
        ? [`  text: ${JSON.stringify(guardLine.text)}`]
        : result
            .filter((e) => e.type === "pipeline_status")
            .map((e) => `  status seen: ${e.text}`)),
    );
    return { ok: !!guardLine, notes };
  },
};

export default scenario;
