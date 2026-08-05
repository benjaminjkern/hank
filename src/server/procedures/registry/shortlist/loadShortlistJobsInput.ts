// Assembles everything the shortlist ranker judges against: the detail-candidate
// pool at one company, what the company does, the user's profile + resume
// summary, and the notes attached to this company and to the individual roles.
// The sub-agent has no tools — this is the ONLY place the shortlist round
// touches the DB before the LLM call, so anything missing here is unreachable.
//
// It does NOT feed this user's past AUTOMATED decisions back in as evidence: a
// prior CLOSE's closeNote is agent prose, and feeding a verdict back in as
// "evidence" of a company-level pattern lets one wrong close snowball into the
// next. A board demotion is not a rejection signal here either — it arrives as
// the candidate's own `priorDeferNote` at commit, not as a separate input.

import { prisma } from "@/server/db/prisma";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { shortlistPoolStatusWhere } from "@/server/entities/jobs/shortlistPool";
import { readResumeBackground } from "@/server/entities/resume/store";
import { readMemory } from "@/server/memory/store";
import type {
  ShortlistJobsInput,
  ShortlistCandidate,
} from "@/server/subagents/registry/shortlistJobs";

export type ShortlistJobsInputLoad =
  | { ok: true; companyName: string; input: ShortlistJobsInput }
  | { ok: false; error: string };

export async function loadShortlistJobsInput(args: {
  userId: string;
  companyId: string;
  // Free-form steer for this round, forwarded to the sub-agent verbatim.
  extraContext?: string;
  // Override the status-based pool with an explicit job list. Used by
  // scripts/shortlist-jobs/replay.ts to re-run the ranker over a historical
  // pool; production callers want the status filter.
  jobIds?: string[];
}): Promise<ShortlistJobsInputLoad> {
  const company = await prisma.company.findUnique({
    where: { id: args.companyId },
    select: { id: true, name: true, slug: true, description: true },
  });
  if (!company) {
    return { ok: false, error: `no company found for id ${args.companyId}` };
  }

  // Detail-candidate pool: every Job at this company whose JobInteraction is in
  // the shortlist pool — SCANNED (survived the scan step's match pass),
  // SHORTLISTED (committed picks, re-ranked so a fresh round can demote them),
  // and the committed passovers (DEFERRED + OUTRANKED, whose deferNote arrives
  // as `priorDeferNote`). NEW is intentionally excluded — the scan step drains
  // NEW into SCANNED/CLOSED first, so a still-NEW row means scan hasn't reached
  // it yet (e.g. a rate-limit straggler) and it shouldn't be ranked until it
  // has. No `take` limit: the sub-agent reads summaries, not bodies, so every
  // survivor at the company is considered in one pass.
  const rows = await prisma.job.findMany({
    where: args.jobIds
      ? { id: { in: args.jobIds }, companyId: args.companyId }
      : {
          companyId: args.companyId,
          jobInteractions: {
            some: {
              userId: args.userId,
              ...shortlistPoolStatusWhere(),
            },
          },
        },
    select: {
      id: true,
      title: true,
      ...ROLE_ATTR_SELECT,
      attributes: true,
      enrichedSummary: true,
      enrichedAttributes: true,
      rawContent: true,
      jobInteractions: {
        where: { userId: args.userId },
        select: {
          matchBucket: true,
          matchScore: true,
          matchReason: true,
          // Why this role was set aside in an earlier round. Non-null only on
          // a re-rank: committed passovers stay DEFERRED + OUTRANKED with the
          // commit's note, and a role later picked had it cleared at the
          // commit seam.
          deferNote: true,
        },
        take: 1,
      },
    },
  });

  if (rows.length === 0) {
    return {
      ok: false,
      error: args.jobIds
        ? `(none of the ${args.jobIds.length} jobIds matched a Job at ${company.name})`
        : `(no SCANNED jobs at ${company.name} — every job is already terminal for this round)`,
    };
  }

  const [profile, resume, companyNote, jobNotes] = await Promise.all([
    readMemory(args.userId, "profile.md"),
    readResumeBackground(args.userId),
    readMemory(args.userId, `companies/${company.slug}.md`),
    // The candidates' own jobs/{slug}.md notes, in one query. Keyed on the
    // denormalized jobId rather than built from slugs: only 43% of Job rows
    // carry a slug, and this way a note on a slug-less job is still found.
    // (`path` stays authoritative — the prefix is what identifies a job note.)
    prisma.memoryNote.findMany({
      where: {
        userId: args.userId,
        jobId: { in: rows.map((j) => j.id) },
        path: { startsWith: "jobs/" },
      },
      select: { jobId: true, content: true },
    }),
  ]);
  const jobNoteByJobId = new Map(
    jobNotes.flatMap((n) => (n.jobId ? [[n.jobId, n.content] as const] : [])),
  );

  const candidates: ShortlistCandidate[] = rows.map((j) => ({
    id: j.id,
    title: j.title,
    enrichedSummary: j.enrichedSummary,
    rawContent: j.rawContent,
    ...toRoleAttrs(j),
    attributes: j.attributes,
    enrichedAttributes: j.enrichedAttributes,
    matchBucket: j.jobInteractions[0]?.matchBucket ?? null,
    matchScore: j.jobInteractions[0]?.matchScore ?? null,
    matchReason: j.jobInteractions[0]?.matchReason ?? null,
    jobNote: jobNoteByJobId.get(j.id) ?? null,
    priorDeferNote: j.jobInteractions[0]?.deferNote ?? null,
  }));

  return {
    ok: true,
    companyName: company.name,
    input: {
      companyName: company.name,
      companyDescription: company.description,
      candidates,
      profile: (profile ?? "").trim() || "(no profile.md yet)",
      resume,
      companyNote,
      ...(args.extraContext ? { extraContext: args.extraContext } : {}),
    },
  };
}
