import { z } from "zod";

import { sayUiEvents, statusEvent } from "@/server/contracts";
import { prisma } from "@/server/db/prisma";
import { WORKABLE_STATUSES } from "@/server/entities/jobs/jobInteractionInputs";
import { promoteJobForWork } from "@/server/entities/jobs/setJobAside";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";
import { JobInteractionStatus } from "@/server/generated/prisma/client";
import { buildShowEvents } from "@/server/panels/showEvents";
import { formatFocusRefToken } from "@/shared/focusRefToken";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// work_on_job — the "user named a specific role to work on / apply to" handoff.
//
// It opens the role and queues the work_on_job procedure, which
// fetches the application form, decides what it can draft, drafts it, and
// self-reviews — EXACTLY what tapping the role in the next-role picker does
// (both go through promoteJobForWork → runWorkOnJob). This is the prose
// counterpart to that widget: when the user says "let's do the X role" the
// procedure should start, not a read-only inspection. Without it Hank reaches for
// view_application_questions, which only INSPECTS a form and will report
// "nothing to draft" on forms the drafting workflow can in fact draft.
//
// handoff:true — the turn ends and the work_on_job procedure owns what shows next
// (drafting status lines → submit prompt / co-write hand-off). This is a pure
// handoff, never an atomic mutation: it does one thing (focus + start the
// workflow) and stops.
export const workOnJobTool: ToolDef<{ job: string }> = {
  name: "work_on_job",
  affectsViewedState: true,
  handoff: true,
  description:
    "Start working on a specific role: focus it and hand off to the application workflow, which fetches the form, works out what it can draft, drafts it, and self-reviews — the same thing that happens when the user taps a role in the next-role picker. Call this whenever the user names a role to work on or apply to ('let's do the AI infra one', 'first one's fine', 'apply to the backend role'), INSTEAD of view_application_questions (that only inspects a form — it can't begin drafting). `job` is the role's slug. A set-aside / deferred role is brought back automatically. Say one natural line first ('Good pick — pulling that up.'), then call this and STOP: the workflow streams its own progress and prompts for submit, so don't narrate the steps yourself.",
  parser: z.object({ job: z.string().describe("The role's slug.") }),
  async handle(input, ctx) {
    const r = await resolveJobBySlug(ctx.userId, input.job);
    if (!r.ok) return slugLookupError(r);
    const jobId = r.value.id;

    // Read the status only to shape the acknowledgement — the actual focus +
    // promote-to-SHORTLISTED write happens inside promoteJobForWork.
    const ji = await prisma.jobInteraction.findFirst({
      where: { userId: ctx.userId, jobId },
      select: { status: true, job: { select: { title: true } } },
    });
    const preApplication =
      ji != null &&
      (ji.status === JobInteractionStatus.NEW ||
        ji.status === JobInteractionStatus.SCANNED ||
        ji.status === JobInteractionStatus.DEFERRED ||
        WORKABLE_STATUSES.includes(ji.status));

    await promoteJobForWork({ userId: ctx.userId, jobId });
    const { events } = await buildShowEvents(ctx.userId, { jobId });
    // Emit the "switched to this role" chip (the prose counterpart to the
    // next_job_picker pick, which chips via narrateJobFocus). Only for the
    // pre-application entry — a non-draftable role hands straight back.
    const roleLabel = ji?.job.title ?? r.value.slug ?? "this role";
    await sayUiEvents(ctx.say, events);
    if (preApplication) {
      await ctx.say(
        statusEvent(
          `Working on ${formatFocusRefToken("job", jobId, roleLabel)}.`,
        ),
      );
    }
    ctx.queue({ kind: "work_on_job", jobId });
    return {
      content: preApplication
        ? `Focused ${r.value.slug} and handed off to the application workflow (form → draftable answers → self-review). Nothing more to do this turn — the workflow streams its own progress; don't restate the steps.`
        : `Focused ${r.value.slug}, but this role isn't in a pre-application state (likely already applied or closed), so the workflow will hand back to this company's role picker rather than draft. Nothing more to do this turn.`,
    };
  },
};
