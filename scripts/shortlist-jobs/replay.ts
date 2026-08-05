// Per-user shortlist replay harness — diff the sub-agent's picks against the
// user's historical choices on the EXACT stage-2 pools that hit shortlistJobs
// (the jobs with SCANNED or SHORTLISTED events at each company), not the full
// post-NEW pool the canonical shortlist-jobs-quality.ts script uses.
//
// Why this exists separately from shortlist-jobs-quality.ts:
//   - quality.ts uses status != NEW, which includes the wider PRE_SCAN-skipped
//     pool — for a media-co with 175 CLOSED jobs that's ~$1+ to replay and
//     mostly noise (PRE_SCAN's pt1 already correctly skipped them).
//   - This script uses jobs with SCANNED|SHORTLISTED events — the actual
//     post-PRE_SCAN survivor pool that the original shortlistJobs sub-agent
//     saw. Same shape as a fresh scan, cheap to run.
//
// Neither needs the past-skips exclusion loadShortlistJobsInput used to carry for
// them: the per-company CLOSED-rows block is gone entirely (it was the same
// agent-prose feedback loop removed from scanJob), so a replay can no longer
// bias toward "the user already passed on these". A replayed pool that was
// passed over DOES still carry its own `deferNote` as `priorDeferNote` — that's
// per-role history the ranker is meant to see, and it downgrades rather than
// closing, so it doesn't collapse the replay into the historical outcome.
//
// Usage:
//   DATABASE_URL=<connection> pnpm exec tsx scripts/shortlist-jobs-replay.ts <userEmail> [companySlug]
//
//   pnpm exec tsx scripts/shortlist-jobs-replay.ts user@example.com
//   pnpm exec tsx scripts/shortlist-jobs-replay.ts user@example.com the-new-york-times

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, JobEventType } from "../../src/generated/prisma/client";
import { loadShortlistJobsInput } from "../../src/server/procedures/registry/shortlist/loadShortlistJobsInput";
import { runSubAgent } from "../../src/server/subagents/lib/runSubAgent";
import { shortlistJobsSubAgent } from "../../src/server/subagents/registry/shortlistJobs";
// Replay drives the real shortlist sub-agent over historical pools for diffing
// — those runs are a harness, not live traffic, so keep them out of SubAgentRun
// (recordSubAgentRun honors this flag; see src/server/agent/subAgentRun.ts).
process.env.HANK_DISABLE_SUBAGENT_CAPTURE = "1";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error(
      "usage: tsx scripts/shortlist-jobs-replay.ts <userEmail> [companySlug]",
    );
    process.exit(1);
  }
  const companySlug = process.argv[3];

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No User found with email ${email}`);

  const session = await prisma.chatSession.findFirst({
    where: { userId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session) throw new Error(`no active ChatSession for ${email}`);

  const companies = await prisma.company.findMany({
    where: {
      ...(companySlug ? { slug: companySlug } : {}),
      jobs: {
        some: {
          jobInteractions: {
            some: {
              userId: user.id,
              events: {
                some: {
                  type: {
                    in: [JobEventType.SCANNED, JobEventType.SHORTLISTED],
                  },
                },
              },
            },
          },
        },
      },
    },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });

  if (companies.length === 0) {
    console.log(
      "No companies with stage-2 events (SCANNED|SHORTLISTED) for this user.",
    );
    return;
  }

  for (const company of companies) {
    const pool = await prisma.job.findMany({
      where: {
        companyId: company.id,
        jobInteractions: {
          some: {
            userId: user.id,
            events: {
              some: {
                type: { in: [JobEventType.SCANNED, JobEventType.SHORTLISTED] },
              },
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        locationAndArrangement: true,
        jobInteractions: {
          where: { userId: user.id },
          select: {
            status: true,
            events: {
              where: { type: JobEventType.SHORTLISTED },
              select: { id: true },
            },
          },
        },
      },
      orderBy: { title: "asc" },
    });
    if (pool.length === 0) continue;

    const titleById = new Map(
      pool.map((j) => [
        j.id,
        `${j.title}  (${j.locationAndArrangement ?? "n/a"})`,
      ]),
    );
    const historicalPicks = new Set(
      pool
        .filter((p) => (p.jobInteractions[0]?.events.length ?? 0) > 0)
        .map((p) => p.id),
    );

    console.log(
      "\n═══════════════════════════════════════════════════════════════",
    );
    console.log(
      `${company.name}  —  stage-2 pool=${pool.length}, historical picks=${historicalPicks.size}`,
    );
    console.log(
      "═══════════════════════════════════════════════════════════════",
    );

    // Replay is read-only by construction now: the sub-agent writes nothing and
    // this script never calls the commit path, so there's no dry-run flag to set.
    const context = await loadShortlistJobsInput({
      userId: user.id,
      companyId: company.id,
      jobIds: pool.map((p) => p.id),
    });
    if (!context.ok) {
      console.log(`  ERROR: ${context.error}`);
      continue;
    }
    const result = await runSubAgent(shortlistJobsSubAgent, context.input, {
      userId: user.id,
      sessionId: session.id,
    });

    if (!result.ok) {
      console.log(`  ERROR: ${result.error}`);
      continue;
    }
    const picks = result.output;
    if (picks.passedJobIds.length === picks.verdicts.length) {
      // Every role skipped — the procedure closes them all and renders no
      // widget. Replay writes nothing, so just report it.
      console.log(
        `  ALL SKIPPED (would close ${picks.verdicts.length}) → ${picks.proposalNote ?? "(no note)"}`,
      );
    }

    const picked = new Set(picks.pickedJobIds);
    console.log(`  proposalNote: ${picks.proposalNote ?? "(none)"}`);
    console.log(`\n  Per-job verdicts:`);
    for (const jobId of pool.map((p) => p.id)) {
      const subAgentPicked = picked.has(jobId);
      const historicallyPicked = historicalPicks.has(jobId);
      const marker = subAgentPicked
        ? historicallyPicked
          ? "✓ ★ SHORTLIST"
          : "+ ★ SHORTLIST"
        : historicallyPicked
          ? "✗   skip/bord"
          : "    skip/bord";
      const reason = picks.reasons[jobId] ?? "(no reason)";
      console.log(`    ${marker}  ${titleById.get(jobId) ?? jobId}`);
      console.log(`                       ↳ ${reason}`);
    }

    // Token spend lands in TokenUsage via the sub-agent template — `pnpm usage`
    // reports it; the sub-agent doesn't hand usage back to its callers.

    const intersection = new Set(
      [...picked].filter((id) => historicalPicks.has(id)),
    );
    const missed = [...historicalPicks].filter((id) => !picked.has(id));
    const added = [...picked].filter((id) => !historicalPicks.has(id));
    console.log(
      `\n  Summary: ✓ match=${intersection.size}/${historicalPicks.size}  ✗ missed=${missed.length}  + added=${added.length}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

// Markers in the verdicts output:
//   ✓ ★ SHORTLIST = sub-agent picked AND user historically picked (match)
//   + ★ SHORTLIST = sub-agent picked but user did not (added)
//   ✗   skip/bord = user historically picked but sub-agent did not (missed)
//       skip/bord = sub-agent did not pick AND user did not pick (agree)
//
// Replays honor JobInteractionStatus.SHORTLISTED via event history (the user may
// have toggled status post-pick); we trust SHORTLISTED events as the
// historical "yes I want this" signal.
