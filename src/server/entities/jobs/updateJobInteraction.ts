import {
  JobInteractionStatus,
  type JobDeferReason,
  Prisma,
  type JobCloseReason,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

type ShortAnswerInput = { question: string; answer: string };

type JobInteractionUpdates = {
  // Set the cached status directly, WITHOUT a backing JobEvent — this is the
  // correction path ("that role isn't closed, it's deferred"), not the
  // something-happened path (log_job_events / mark_job_applied / close_job /
  // defer_job, which write the event and let it drive the status). Passing it
  // applies the clear-on-transition rule below.
  status?: JobInteractionStatus;
  coverLetter?: string | null;
  shortAnswers?: ShortAnswerInput[] | null;
  closeReason?: JobCloseReason | null;
  closeNote?: string | null;
  deferReason?: JobDeferReason | null;
  deferNote?: string | null;
  // Attach (or detach with null) the JobInteraction to/from an inbound
  // Opportunity (lead). Used at intake when the recruiter pitches a role that
  // matches an existing Job — the agent reuses the existing JobInteraction
  // instead of creating a duplicate, and sets this field to wire it into the
  // lead.
  opportunityId?: string | null;
};

// Shared partial-update upsert for one user's JobInteraction (NOT
// CompanyInteraction — that's entities/companies). Used by the
// update_job_interaction agent tool and the client-facing PATCH route so the two
// surfaces stay byte-identical. Returns the list of field names that were
// applied (for the tool's result string).
export async function updateJobInteraction(
  userId: string,
  jobId: string,
  updates: JobInteractionUpdates,
): Promise<string[]> {
  const data: Prisma.JobInteractionUncheckedUpdateInput = {};
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.coverLetter !== undefined) data.coverLetter = updates.coverLetter;
  if (updates.shortAnswers !== undefined)
    data.shortAnswers =
      updates.shortAnswers === null ? Prisma.JsonNull : updates.shortAnswers;
  if (updates.closeReason !== undefined) data.closeReason = updates.closeReason;
  if (updates.closeNote !== undefined) data.closeNote = updates.closeNote;
  if (updates.deferReason !== undefined) data.deferReason = updates.deferReason;
  if (updates.deferNote !== undefined) data.deferNote = updates.deferNote;
  if (updates.opportunityId !== undefined)
    data.opportunityId = updates.opportunityId;

  // Snapshot the caller's fields BEFORE clear-on-transition, so the returned
  // list is what was asked for — the nulls the rule adds below are bookkeeping,
  // not an update the agent requested, and echoing them back reads as "I also
  // wiped your close reason" on an unrelated status fix.
  const keys = Object.keys(data);
  if (keys.length === 0) return [];

  // Clear-on-transition: a status write sets BOTH reason/note pairs explicitly
  // so a status chain never strands the previous status's "why" (a CLOSED row
  // revived to SHORTLISTED keeping its closeReason reads as still-closed to the
  // dashboard and to whats_next). Same rule closeJob/deferJob apply on their
  // side (entities/jobs/setJobAside.ts). Explicit input for the matching pair wins.
  if (updates.status !== undefined) {
    if (updates.status !== JobInteractionStatus.CLOSED) {
      data.closeReason = null;
      data.closeNote = null;
    }
    if (updates.status !== JobInteractionStatus.DEFERRED) {
      data.deferReason = null;
      data.deferNote = null;
    }
    if (updates.closeReason !== undefined)
      data.closeReason = updates.closeReason;
    if (updates.closeNote !== undefined) data.closeNote = updates.closeNote;
    if (updates.deferReason !== undefined)
      data.deferReason = updates.deferReason;
    if (updates.deferNote !== undefined) data.deferNote = updates.deferNote;
    // Stance clear-on-transition (same rule logJobEvents applies): a status
    // correction ends whatever the shortlist board proposed for this row.
    data.proposedVerdict = null;
    data.placementVerdict = null;
    data.proposedReason = null;
    data.proposedBy = null;
    data.proposedAt = null;
  }

  await prisma.jobInteraction.upsert({
    where: { userId_jobId: { userId, jobId } },
    update: data,
    // Same field set on the create side — every column the update can touch,
    // so a first write to a not-yet-existing JobInteraction can't silently drop
    // one of them while `keys` still reports it as applied.
    create: {
      ...(data as Prisma.JobInteractionUncheckedCreateInput),
      userId,
      jobId,
      status:
        (data.status as JobInteractionStatus | undefined) ??
        JobInteractionStatus.NEW,
    },
  });

  return keys;
}
