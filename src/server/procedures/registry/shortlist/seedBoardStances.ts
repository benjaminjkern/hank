// The write half of the shortlist_jobs call: apply the pick ceiling to what the
// ranker proposed, then land one stance per pool row in a single transaction.
// Stances only — no status changes, no events; commit_shortlist is where the
// board becomes real (entities/companies/commitShortlist.ts).

import { ProposedVerdict } from "@/generated/prisma/client";
import { bulkUpdate, type Database } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";
import { shortlistPoolStatusWhere } from "@/server/entities/jobs/shortlistPool";
import type { ShortlistJobsOutput } from "@/server/subagents/registry/shortlistJobs";

// Hard ceiling on picks. The shortlist is meant to be the 3-5 STRONGEST fits,
// not every job that survived the absolute scan filter. The prompt asks for ≤5,
// but a big board of mostly-on-thesis roles drifts up. This is the
// deterministic backstop: if the model picks more than this, keep the strongest
// CAP by (scan bucket, scan score) and demote the rest to borderline — they
// stay on the board with their reasons, just not picked.
const SHORTLIST_CAP = 5;

export type ShortlistRankable = {
  id: string;
  matchBucket: string | null;
  matchScore: number | null;
};

// Priority for the cap demotion: STRONG > POSSIBLE > WEAK > unknown, then
// higher scan score (null sorts last), then earlier position in the pool.
// matchScore is only ~80% populated in practice, so bucket is the primary key
// and score only breaks within-bucket ties.
function bucketPriority(bucket: string | null): number {
  switch (bucket) {
    case "STRONG":
      return 3;
    case "POSSIBLE":
      return 2;
    case "WEAK":
      return 1;
    default:
      return 0;
  }
}

// Trim `pickedJobIds` to the strongest SHORTLIST_CAP. Returns the kept ids
// plus the raw count, so callers can report "model wanted N, shipped M".
export function capShortlistPicks(
  pickedJobIds: string[],
  candidates: ShortlistRankable[],
): { kept: string[]; rawCount: number; capped: boolean } {
  const rawCount = pickedJobIds.length;
  if (rawCount <= SHORTLIST_CAP) {
    return { kept: pickedJobIds, rawCount, capped: false };
  }
  const meta = new Map(
    candidates.map((c, pos) => [
      c.id,
      { bucket: c.matchBucket, score: c.matchScore, pos },
    ]),
  );
  const fallback = {
    bucket: null,
    score: null,
    pos: Number.MAX_SAFE_INTEGER,
  };
  const kept = [...pickedJobIds]
    .sort((a, b) => {
      const A = meta.get(a) ?? fallback;
      const B = meta.get(b) ?? fallback;
      const byBucket = bucketPriority(B.bucket) - bucketPriority(A.bucket);
      if (byBucket !== 0) return byBucket;
      const byScore = (B.score ?? -1) - (A.score ?? -1);
      if (byScore !== 0) return byScore;
      return A.pos - B.pos;
    })
    .slice(0, SHORTLIST_CAP);
  return { kept, rawCount, capped: true };
}

// Returns nothing: what landed is read back off the BOARD, which also carries
// the roles this round's earlier passes closed. A tally counted here can only
// ever describe the candidates the ranker saw, and quoting it beside a screen
// showing the rest is what made the seed message contradict the panel.
export async function seedBoardStances(args: {
  userId: string;
  companyId: string;
  candidates: ShortlistRankable[];
  picks: ShortlistJobsOutput;
}): Promise<void> {
  const { kept } = capShortlistPicks(args.picks.pickedJobIds, args.candidates);
  const keptSet = new Set(kept);
  const passedSet = new Set(args.picks.passedJobIds);
  const now = new Date();
  // Each row carries its own stance reason, so there is no `updateMany` that
  // covers them all — that per-row-values case is exactly what bulkUpdate is
  // for, and it is ONE statement for the whole board.
  //
  // The status guard lives in the read above: a row that left the pool between
  // load and write is filtered out here rather than silently no-op'ing.
  const live = await prisma.jobInteraction.findMany({
    where: {
      userId: args.userId,
      jobId: { in: args.candidates.map((c) => c.id) },
      ...shortlistPoolStatusWhere(),
    },
    select: { id: true, jobId: true },
  });
  const interactionIdByJobId = new Map(live.map((r) => [r.jobId, r.id]));

  const patches: Array<{
    key: string;
    patch: Partial<Database["JobInteraction"]>;
  }> = [];
  for (const c of args.candidates) {
    const verdict = keptSet.has(c.id)
      ? ProposedVerdict.PICK
      : passedSet.has(c.id)
        ? ProposedVerdict.PASS
        : ProposedVerdict.BORDERLINE;
    const interactionId = interactionIdByJobId.get(c.id);
    if (!interactionId) continue;
    patches.push({
      key: interactionId,
      patch: {
        agentVerdict: verdict,
        // A seed PLACES as it stances — the board is being drawn fresh, so
        // there is no earlier grouping to hold rows in. Only a user's later
        // mark leaves placement behind (see setBoardStance).
        placementVerdict: verdict,
        agentReason: args.picks.reasons[c.id] ?? null,
        stanceAt: now,
      },
    });
  }
  await bulkUpdate("JobInteraction", "id", patches);
}
