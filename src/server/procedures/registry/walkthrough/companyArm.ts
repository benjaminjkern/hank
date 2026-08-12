// The company arm (steps 0-3): the rung ladder for walking ONE company.
//
//   revive-confirm if it was set aside → prep/refresh the board → prescan + scan
//   the unreviewed postings → shortlist board (seed or re-show) → offer the
//   remaining roles → mark caught up if nothing is left.
//
// Every rung re-derives its position from the DB, so re-entering just lands on
// the first thing that still needs doing.

import {
  CompanyStatus,
  JobEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";
import { statusEvent, widgetEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { WORKABLE_STATUSES } from "@/server/entities/jobs/jobInteractionInputs";
import { markCompanyReady } from "@/server/entities/companies/markCompanyStatus";
import { caughtUpCompany } from "@/server/entities/companies/setCompanyAside";
import { roundStartedAt } from "@/server/entities/jobs/boardStance";
import { onBoardWhere } from "@/server/entities/jobs/shortlistPool";
import { runPreScan } from "@/server/procedures/registry/preScan";
import { preScanPoolWhere } from "@/server/procedures/registry/preScan/pool";
import { runScan } from "@/server/procedures/registry/scan";
import { runShortlist } from "@/server/procedures/registry/shortlist";

import { isScrapeStale, runBoardScrape } from "./boardScrape";
import { runCompanyEnrichStep } from "./companyEnrichStep";
import { narrateCompanyCaughtUp } from "./narration";
import { summarizeCloseRationales } from "./summarizeCloseRationales";
import { yieldStateChange } from "./yieldStateChange";

import type { WalkthroughArgs, WalkthroughResult } from "./types";

export async function* runCompanyArm(
  entryCompanyId: string,
  args: WalkthroughArgs,
  // Free-text steer for the shortlist rung, forwarded from company_walkthrough's
  // `direction`. Only the shortlist rung reads it; the earlier rungs (revive,
  // prep, scrape, scan) are unconditional work that a steer can't change.
  direction?: string,
): AsyncGenerator<TurnEvent, WalkthroughResult> {
  // Rebound by the enrich step: hunting a board URL another Company row already
  // holds merges this user's watchlist entry into that row and deletes the stub,
  // so every rung below must run against the surviving id.
  let companyId = entryCompanyId;

  // Rung 0: the company was set aside. Walking it again is a REVIVE, and a
  // revive is the user's call — ask before re-checking a board they closed.
  // It lives in the arm rather than in company_walkthrough so that every way in
  // — the tool, a picker pick, a later re-entry — asks the same question, and
  // the deterministic layer owns every wait-for-user surface. CLOSED = a fit
  // dead-end;
  // BLOCKED = we couldn't read their board.
  const revivable = await prisma.companyInteraction.findUnique({
    where: { userId_companyId: { userId: args.userId, companyId } },
    select: { status: true, company: { select: { name: true } } },
  });
  if (
    revivable &&
    (revivable.status === CompanyStatus.CLOSED ||
      revivable.status === CompanyStatus.BLOCKED)
  ) {
    const name = revivable.company.name;
    yield widgetEvent("confirm_revive_company", {
      companyId,
      companyName: name,
      reasoning:
        revivable.status === CompanyStatus.BLOCKED
          ? `${name} was set aside earlier because I couldn't read their careers page. Want me to re-check it now and pull in anything that's posted?`
          : `${name} was set aside earlier because its open roles didn't line up with what you're looking for. Want me to pull it back up and check for anything new?`,
    });
    return { wrappedUp: false };
  }

  // Step 0a: know who the company is before touching their board — careers URL,
  // canonical name, description, logo. Flag-guarded inside, so this is a cheap
  // Postgres round-trip once a company is enriched, and the full hunt exactly
  // once. AWAITED rather than fired off: per the "nothing runs behind Hank's
  // back" invariant, a detached promise that lands writes after the user moved
  // on — and ignores a Stop — is the hidden work we're removing.
  const enriched = yield* runCompanyEnrichStep(companyId, args);
  if (enriched.wrapped) {
    return { wrappedUp: true, endedCompanyId: enriched.endedCompanyId };
  }
  companyId = enriched.companyId;

  // Step 0b: pull the board when there's nothing on file yet, or what's on file
  // has gone stale (SCRAPE_STALENESS_MS) — that's what makes "walk Reddit"
  // surface today's roles instead of a weeks-old snapshot. After one scrape
  // lastScrapedJobsAt is fresh, so same-session re-entries skip it.
  //
  // Count THIS USER's roles, not the global Job table: a company can carry Job
  // rows from another user's scan while this user has zero JobInteractions.
  // Gating on the global count let those skip the scrape, hit newCount===0, and
  // fall through to "caught up" showing nothing — the user clicks a company and
  // it vanishes with no roles.
  const userJobCount = await prisma.jobInteraction.count({
    where: { userId: args.userId, job: { companyId } },
  });
  const ci0 = await prisma.companyInteraction.findUnique({
    where: { userId_companyId: { userId: args.userId, companyId } },
    select: {
      lastScrapedJobsAt: true,
      company: { select: { name: true, sourceUrl: true } },
    },
  });
  // Genuinely-new postings this entry pulled in. Step 1 narrates these
  // separately from the not-yet-reviewed backlog. 0 when no scrape ran.
  let scrapeDelta = 0;
  if (
    ci0?.company.sourceUrl &&
    (userJobCount === 0 || isScrapeStale(ci0.lastScrapedJobsAt))
  ) {
    const scraped = yield* runBoardScrape(
      companyId,
      ci0.company.sourceUrl,
      ci0.company.name,
      userJobCount > 0,
      args,
    );
    if (scraped.wrapped) {
      return { wrappedUp: true, endedCompanyId: scraped.endedCompanyId };
    }
    scrapeDelta = scraped.delta;
  }

  // Step 1: triage NEW jobs. PRE_SCAN does the cheap metadata obvious-no
  // filter, then the scan step (enrich + per-job match) reads each survivor's
  // full posting, enriches the global Job, and decides SCANNED-vs-CLOSED per
  // job. Together they drain the NEW bucket; whatever's left SCANNED goes to
  // the shortlist rollup in step 2.
  //
  // The two phases gate on different counts because NEW is where a role waits
  // for BOTH of them: `unjudged` is what the metadata pass hasn't seen, and the
  // scan reads every NEW row regardless of which entry stamped it. Gating both
  // on the same count is what made a half-finished scan re-run the metadata pass
  // over roles it had already kept.
  const unjudgedCount = await prisma.jobInteraction.count({
    where: { userId: args.userId, job: { companyId }, ...preScanPoolWhere() },
  });
  const newCount = await prisma.jobInteraction.count({
    where: {
      userId: args.userId,
      status: JobInteractionStatus.NEW,
      job: { companyId },
    },
  });
  if (newCount > 0) {
    // Phase A — PRE_SCAN, the cheap metadata pass. Narrated distinctly from the
    // scan step because its per-job sub-agents run without a parentToolUseId
    // and so have no chip to trace into: these lines are the only way the
    // two-stage flow is visible in the chat at all.
    //
    // Don't call the whole pool "new" — only `scrapeDelta` of these came in
    // this entry; the rest are postings pulled in earlier that nothing has
    // reviewed yet. Conflating the two reads as a contradiction ("Found 4 new…
    // first pass over 75 new").
    if (unjudgedCount > 0) {
      const backlogCount = unjudgedCount - scrapeDelta;
      const firstPassLine =
        scrapeDelta > 0 && backlogCount > 0
          ? `Doing a first pass over ${unjudgedCount} postings — the ${scrapeDelta} new plus ${backlogCount} I hadn't reviewed yet…`
          : scrapeDelta > 0 && backlogCount === 0
            ? `Doing a first pass over ${unjudgedCount} new posting${unjudgedCount === 1 ? "" : "s"}…`
            : `Doing a first pass over ${unjudgedCount} posting${unjudgedCount === 1 ? "" : "s"} I haven't reviewed yet…`;
      yield statusEvent(firstPassLine);
      await runPreScan({ ...args, companyId });
    }

    // Phase B — the scan step proper. Count what's still NEW (the metadata
    // pass's survivors, plus anything an earlier entry stamped and never got to
    // read) so the funnel is visible: "first pass over 218 → reading 17 in
    // full". Skip the scan + its narration when nothing survived the metadata
    // filter (the company wraps to caught-up in step 3).
    const survivorCount = await prisma.jobInteraction.count({
      where: {
        userId: args.userId,
        status: JobInteractionStatus.NEW,
        job: { companyId },
      },
    });
    if (survivorCount === 0) {
      yield statusEvent(
        `None of the ${unjudgedCount} new posting${unjudgedCount === 1 ? "" : "s"} looked like a fit on a first pass.`,
      );
      // Deliberately no company-status write here. PRE_SCAN doesn't land one,
      // and an empty metadata pass mid-walkthrough doesn't mean "caught up" —
      // there may still be SCANNED/SHORTLISTED roles from an earlier visit for
      // steps 2/2.5 to work through. Step 3 makes the caught-up call once it
      // knows nothing is pickable.
    } else {
      // Survivors to read → the company is walkable. READY only overwrites the
      // pre-walkthrough states, so an APPLYING company isn't demoted.
      await markCompanyReady(companyId, args.userId);
      yield statusEvent(
        `Reading ${survivorCount} that look promising in full and matching them to your thesis…`,
      );
      const scan = await runScan({ ...args, companyId });
      if (scan.rateLimited) {
        // Hit a rate-limit wall mid-scan — some jobs are still NEW. Don't run
        // the shortlist on a partial pool. Bail with wrappedUp:false; the next
        // turn re-enters this arm, re-runs scan (enrichment is cached on the
        // Job and the match pass only touches NEW rows), and finishes the rest.
        yield statusEvent(
          "Hit a rate limit partway through — say the word and I'll pick up the rest.",
        );
        return { wrappedUp: false };
      }
      if (scan.total > 0) {
        const setAside =
          scan.skipped > 0 ? `, set ${scan.skipped} aside as off-thesis` : "";
        yield statusEvent(
          `Read ${scan.total} in full — ${scan.matched} look like a fit${setAside}.`,
        );
      }
    }
  }

  // Step 2: the shortlist board. Reached when there's something to decide —
  // SCANNED roles waiting for a seed, a negotiation already open (the board
  // re-shows for free), or a `direction` asking for a fresh ranking of an
  // already-decided shortlist ("infra roles only" re-ranks committed picks too;
  // nothing is SCANNED there, so without the direction branch the rung would
  // no-op straight to the job picker). runShortlist ends the pass either way:
  // the board is on screen and the negotiation waits on the user.
  const scannedCount = await prisma.jobInteraction.count({
    where: {
      userId: args.userId,
      status: JobInteractionStatus.SCANNED,
      job: { companyId },
    },
  });
  const openStanceCount = await prisma.jobInteraction.count({
    where: {
      userId: args.userId,
      ...onBoardWhere(),
      job: { companyId },
    },
  });
  const rerankable =
    direction != null && scannedCount === 0
      ? await prisma.jobInteraction.count({
          where: {
            userId: args.userId,
            status: {
              in: [...WORKABLE_STATUSES, JobInteractionStatus.DEFERRED],
            },
            job: { companyId },
          },
        })
      : 0;
  // A round that ruled EVERY role out still gets a board, and `openStanceCount`
  // is what carries that: the automatic passes stance the roles they rule out
  // rather than closing them, so "everything was filtered" leaves a boardful of
  // passes exactly like "the ranker passed on the survivors" does. The commit
  // clears every stance, which is also what stops this re-entering the board it
  // just settled.
  if (scannedCount > 0 || openStanceCount > 0 || rerankable > 0) {
    yield* runShortlist({ ...args, companyId, direction });
    return { wrappedUp: false };
  }

  // Step 2.5: SHORTLISTED + DEFERRED at this company are the two pools the
  // user can pick between. Emit a next_job_picker widget instead of silently
  // auto-focusing the stalest SHORTLISTED; this surfaces DEFERRED roles too
  // (so a company entered while deferred-with-no-shortlisted doesn't slam
  // straight to CAUGHT_UP) and gives the user agency over what to work on
  // next, including between jobs after a wrap ends the prior one.
  const pickable = await loadPickableJobs(args.userId, companyId);
  if (pickable.shortlisted.length + pickable.deferred.length > 0) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    yield widgetEvent("next_job_picker", {
      companyId,
      companyName: company?.name ?? "this company",
      shortlisted: pickable.shortlisted,
      deferred: pickable.deferred,
    });
    return { wrappedUp: false };
  }

  // Step 3: nothing pickable at this company (no SHORTLISTED, no DEFERRED).
  //
  // Distinguish "the user worked through everything" (legitimately caught up)
  // from "the scan surfaced nothing that matched them". The latter must NOT
  // read as a silent "caught up" — that's the demoralizing click-a-company-
  // get-nothing dead-end. The match check IS the prescan/scan (by design, run
  // when companies are committed), so if the company has postings on file but
  // none are live for this user (nothing SCANNED/SHORTLISTED/APPLIED+) and the
  // rest were skipped, say so plainly and set the company aside.
  const liveCount = await prisma.jobInteraction.count({
    where: {
      userId: args.userId,
      job: { companyId },
      status: {
        notIn: [
          JobInteractionStatus.NEW,
          JobInteractionStatus.CLOSED,
          JobInteractionStatus.DEFERRED,
        ],
      },
    },
  });
  const skippedCount = await prisma.jobInteraction.count({
    where: {
      userId: args.userId,
      job: { companyId },
      status: JobInteractionStatus.CLOSED,
    },
  });
  if (liveCount === 0 && skippedCount > 0) {
    // Scan + prescan eliminated everything (e.g. DeepMind: 25 roles → all set
    // aside by the metadata/scan pass without anything making the shortlist).
    //
    // This is a SHALLOW elimination — nobody read these roles deeply and
    // weighed the company, so it must NOT terminally close the company. Per the
    // "smart default by reason" decision: a metadata/scan cull means "nothing
    // fits right now," which is CAUGHT_UP (keep on the list, check back), not a
    // close. (The considered close lives on the other path — the shortlist
    // sub-agent reading job bodies and declining, e.g. Cerebras's hardware
    // domain dead-end. That path still closes.) Closing here was the DeepMind
    // bug: Hank set everything aside, then popped a "close this company?" widget
    // when the user just wanted it kept.
    //
    // We narrate the specific reason (non-silent — the demoralizing dead-end was
    // a *silent* caught-up, not a clearly-explained one) and let the user steer
    // from chat: "reopen the X role" / "close them out" both work now that
    // skip/defer/reopen are available in every flow.
    const c = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    const who = c?.name ?? "this company";
    // The prescan/scan already recorded WHY each job was dropped, per job, on
    // its structured closeSummaryLabel. Summarize them so the user gets a
    // specific, defensible account ("12 sales roles, 3 product roles, and 2 in
    // Europe") instead of a vague "none line up" — the generic version reads as
    // hand-wavy and invites "but surely they have something?" pushback.
    //
    // Scoped to THIS round, the same boundary the board's filtered tail uses.
    // Counting every close the company ever had lets an old round's dominant
    // reason keep voting, and inflates the "N open roles" number past what this
    // pass actually looked at.
    const roundStart = await roundStartedAt(args.userId, companyId);
    const closed = roundStart
      ? await prisma.jobInteraction.findMany({
          where: {
            userId: args.userId,
            job: { companyId },
            status: JobInteractionStatus.CLOSED,
            events: {
              some: {
                type: JobEventType.CLOSED,
                occurredAt: { gte: roundStart },
              },
            },
          },
          select: { closeSummaryLabel: true },
        })
      : [];
    const detail = summarizeCloseRationales(
      closed.flatMap((row) => {
        const label = row.closeSummaryLabel?.trim();
        return label ? [label] : [];
      }),
    );
    // Only claim a number when it's the number this pass actually went through.
    const reasoning =
      detail && closed.length > 0
        ? `I went through ${who}'s ${closed.length} open role${closed.length === 1 ? "" : "s"} and none line up with what you're looking for right now — ${detail}. I'll keep ${who} on your list and check back next time. Just say the word if you want to reopen any of those or close ${who} out.`
        : `I went through ${who}'s open roles, but none line up with what you're looking for right now. I'll keep ${who} on your list and check back next time. Just say the word if you want to reopen any of those or close ${who} out.`;
    yield { type: "text", text: reasoning };
    // Walkthrough wrap: land the right engagement tail (IN_FLIGHT/IN_PROCESS if
    // apps went out this round, else CAUGHT_UP) instead of forcing CAUGHT_UP.
    await caughtUpCompany({ userId: args.userId, companyId, derive: true });
    // Deliberately NOT narrated — the reasoning above already told the user, in
    // specifics, what happened; the generic "Marked X as caught up" would repeat it.
    return { wrappedUp: true, endedCompanyId: companyId };
  }

  // Otherwise the user genuinely worked through it — wrap up as caught up.
  const { status } = await caughtUpCompany({ userId: args.userId, companyId });
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });
  yield* yieldStateChange(
    narrateCompanyCaughtUp({
      companyId,
      companyName: company?.name ?? null,
      status,
    }),
  );
  return { wrappedUp: true, endedCompanyId: companyId };
}

// Build the SHORTLISTED + DEFERRED row lists for the next_job_picker payload.
// Both sort by updatedAt asc — stalest first, and the stable order given
// deferred roles carry no revisit timer.
// Re-entering the arm (company_walkthrough) is how Hank surfaces the remaining
// roles after an atomic apply/close/defer — the earlier rungs no-op and it lands
// on Step 2.5.
async function loadPickableJobs(
  userId: string,
  companyId: string,
): Promise<{
  shortlisted: Array<{
    jobId: string;
    title: string;
    location: string | null;
    compensation: string | null;
  }>;
  deferred: Array<{
    jobId: string;
    title: string;
    deferReason: string | null;
  }>;
}> {
  const [shortlisted, deferred] = await Promise.all([
    prisma.jobInteraction.findMany({
      where: {
        userId,
        status: { in: WORKABLE_STATUSES },
        job: { companyId },
      },
      orderBy: { updatedAt: "asc" },
      select: {
        jobId: true,
        job: {
          select: {
            title: true,
            locationAndArrangement: true,
            compensation: true,
          },
        },
      },
    }),
    prisma.jobInteraction.findMany({
      where: {
        userId,
        status: JobInteractionStatus.DEFERRED,
        job: { companyId },
      },
      orderBy: { updatedAt: "asc" },
      select: {
        jobId: true,
        deferReason: true,
        job: { select: { title: true } },
      },
    }),
  ]);
  return {
    shortlisted: shortlisted.map((row) => ({
      jobId: row.jobId,
      title: row.job.title,
      location: row.job.locationAndArrangement,
      compensation: row.job.compensation,
    })),
    deferred: deferred.map((row) => ({
      jobId: row.jobId,
      title: row.job.title,
      deferReason: row.deferReason,
    })),
  };
}
