import { JobInteractionStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { runWalkthrough } from "@/server/procedures/registry/walkthrough";

import { SESSION_ID, USER_ID, withFocus } from "../lib";

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
        const gen = runWalkthrough({
          userId: USER_ID,
          sessionId: SESSION_ID,
          userMessage: "",
          // Focus is ephemeral — dispatch runs off the threaded entry target,
          // not the slot. (withFocus still sets the slot but it's now ignored.)
          entryTarget: { kind: "job", id: target.jobId },
        });
        let count = 0;
        while (count < 8) {
          const next = await gen.next();
          if (next.done) break;
          const ev = next.value;
          if (ev.type === "text") events.push({ type: "text", text: ev.text });
          else if (ev.type === "pipeline_status")
            events.push({ type: "pipeline_status", text: ev.text });
          else events.push({ type: ev.type });
          count++;
          // Break early once we see the guard narration. State machine may
          // re-dispatch into runCompanyArm next and we don't want it to
          // recover anything else.
          const last = events[events.length - 1];
          if (
            last?.type === "pipeline_status" &&
            last.text?.match(/no longer shortlisted/i)
          ) {
            break;
          }
        }
        await gen.return({ wrappedUp: false });
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
