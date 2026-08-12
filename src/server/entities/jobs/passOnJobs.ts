// Propose passing on a batch of roles — the write both automatic passes make
// instead of closing.
//
// A round changes no status until it is committed, so the metadata pass and the
// full read leave a PASS stance here and the commit is what turns it into
// `CLOSED`. That is the whole point: the board shows a proposal the user can
// overturn by clicking one of the other two marks, rather than a decision they
// have to undo. It also means a cleared stance IS the round boundary, so nothing
// downstream compares timestamps to work out which closes belong to this round.
//
// `closeReason` / `closeSummaryLabel` are written NOW even though the row isn't
// closed: they describe the pass being proposed, and the commit needs them the
// moment it lands. They are self-cleaning — the commit's PICK and BORDERLINE
// branches null both, so a row the user overturns wipes the reason it was going
// to be closed with.
//
// No JobEvent. Nothing has happened to the role yet; the commit logs the close.

import { ProposedVerdict } from "@/generated/prisma/client";
import type { EliminatedBy, JobCloseReason } from "@/generated/prisma/client";
import { bulkUpdate, type Database } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";
import { nowDate } from "@/utils/now";

export async function passOnJobs(args: {
  userId: string;
  // Which pass is proposing this, so the board can order its closing pile by how
  // far each role got before something ruled it out.
  eliminatedBy: EliminatedBy;
  // A reason AND a note per job: the reason is what the dashboard and
  // `whats_next` query against once the pass lands, while the note is the
  // sentence the user reads next to that specific role on the board.
  jobs: Array<{
    id: string;
    closeReason: JobCloseReason;
    closeNote: string;
    closeSummaryLabel?: string | null;
  }>;
}): Promise<number> {
  if (args.jobs.length === 0) return 0;

  // One read to map jobIds → JobInteraction ids, then one write. A row that left
  // the pool between the sub-agent call and here is simply absent from the read,
  // which is the guard: no silent no-op update against a stale id.
  const live = await prisma.jobInteraction.findMany({
    where: { userId: args.userId, jobId: { in: args.jobs.map((j) => j.id) } },
    select: { id: true, jobId: true },
  });
  const interactionIdByJobId = new Map(live.map((r) => [r.jobId, r.id]));

  const now = nowDate();
  const patches: Array<{
    key: string;
    patch: Partial<Database["JobInteraction"]>;
  }> = [];
  for (const job of args.jobs) {
    const key = interactionIdByJobId.get(job.id);
    if (!key) continue;
    patches.push({
      key,
      patch: {
        agentVerdict: ProposedVerdict.PASS,
        // The pass PLACES as it stances — it is drawing the board for the first
        // time, so there is no earlier grouping to hold the row in. Only a
        // user's later mark leaves placement behind (see setBoardStance).
        placementVerdict: ProposedVerdict.PASS,
        agentReason: job.closeNote,
        eliminatedBy: args.eliminatedBy,
        closeReason: job.closeReason,
        closeSummaryLabel: job.closeSummaryLabel ?? null,
        stanceAt: now,
      },
    });
  }
  await bulkUpdate("JobInteraction", "id", patches);
  return patches.length;
}
