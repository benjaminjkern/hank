// The job detail page's loader. The payload type is shared/views/getFocusedJob.ts.

import { prisma } from "@/server/db/prisma";
import { loadMergedQuestions } from "@/server/entities/jobs/applicationQuestions";
import { liveVerdict, placedVerdict } from "@/server/entities/jobs/boardStance";
import { flipDueInterviewsToDebrief } from "@/server/entities/jobs/flipDueInterviews";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import {
  isStanceable,
  onBoardWhere,
} from "@/server/entities/jobs/shortlistPool";
import { JobInteractionStatus } from "@/server/generated/prisma/client";
import type { ShortAnswer } from "@/shared/applicationDrafts";
import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
} from "@/shared/applicationQuestions";
import { companyLogoUrl } from "@/shared/companyLogo";
import type { FocusedJobView } from "@/shared/views/getFocusedJob";

// Shared loader for a single job + the current user's JobInteraction. Used by
// /api/session, /api/jobs/[id], and the agent's show_job tool so the SSE
// payload and the page hydration are byte-identical. ("Focused" here just
// means the rich detail-page payload — there's no focus slot anymore.)
export async function getFocusedJobView(
  userId: string,
  jobId: string,
): Promise<FocusedJobView | null> {
  // Lazy-flip any due interview rows before reading so the job's status
  // reflects "user owes a debrief" when the interview date has passed.
  await flipDueInterviewsToDebrief();
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      slug: true,
      title: true,
      sourceUrl: true,
      rawContent: true,
      ...ROLE_ATTR_SELECT,
      // applicationQuestions + userAddedQuestions are read (and merged) by
      // loadMergedQuestions below, not selected here.
      companyName: true,
      closedAt: true,
      company: {
        select: {
          id: true,
          slug: true,
          name: true,
          sourceUrl: true,
          logoUrl: true,
        },
      },
      jobInteractions: {
        where: { userId },
        select: {
          status: true,
          closeReason: true,
          closeNote: true,
          deferReason: true,
          deferNote: true,
          agentVerdict: true,
          agentReason: true,
          userVerdict: true,
          placementVerdict: true,
          applyChannel: true,
          coverLetter: true,
          shortAnswers: true,
          coverLetterReuse: true,
          shortAnswersReuse: true,
          opportunity: { select: { id: true, label: true } },
          events: {
            orderBy: { occurredAt: "desc" },
            select: { id: true, type: true, occurredAt: true, notes: true },
          },
        },
        take: 1,
      },
    },
  });
  if (!job?.jobInteractions[0]) return null;
  const i = job.jobInteractions[0];

  // Is a round open at this company? Same predicate the board uses, so a role
  // opened from the board is markable here for exactly as long as it is there.
  // An unaffiliated role (no company) can't be in a round at all.
  const boardOpenCount = job.company
    ? await prisma.jobInteraction.count({
        where: {
          userId,
          job: { companyId: job.company.id },
          ...onBoardWhere(),
        },
      })
    : 0;
  const board =
    boardOpenCount > 0
      ? {
          // What the board would show selected: the live stance, or the group
          // the row's own status places it in.
          verdict: liveVerdict(i) ?? placedVerdict(i),
          markable: isStanceable(i.status),
          filtered: i.status === JobInteractionStatus.CLOSED,
        }
      : null;

  // Expose the scraped form MERGED with any user-added questions (Job.userAdded
  // Questions), each tagged with its source so the panel can badge the hand-added
  // ones as unverified. When there are questions (scraped or user-added) we
  // present an "ok" envelope; with none we pass the raw scraped envelope through
  // so its empty/unsupported/error placeholder still renders. (Only source is
  // surfaced to the client — not addedByUserId, which is another user's id.)
  const mq = await loadMergedQuestions(job.id);
  const mergedQuestions: ApplicationQuestion[] = mq.merged.map((q) => ({
    question: q.question,
    ...(q.required !== undefined ? { required: q.required } : {}),
    ...(q.type ? { type: q.type } : {}),
    source: q.source,
  }));
  const scrapedFetchedAt =
    mq.envelope && "fetchedAt" in mq.envelope
      ? mq.envelope.fetchedAt
      : undefined;
  const applicationQuestions: ApplicationQuestionsEnvelope | null =
    mergedQuestions.length > 0
      ? {
          status: "ok",
          questions: mergedQuestions,
          ...(mq.formWantsCoverLetter ? { coverLetter: true } : {}),
          fetchedAt: scrapedFetchedAt ?? "",
        }
      : mq.envelope;

  return {
    id: job.id,
    slug: job.slug,
    title: job.title,
    sourceUrl: job.sourceUrl,
    description: job.rawContent,
    ...toRoleAttrs(job),
    applicationQuestions,
    company: job.company
      ? {
          id: job.company.id,
          slug: job.company.slug,
          name: job.company.name,
          logoUrl: companyLogoUrl(job.company.sourceUrl, job.company.logoUrl),
        }
      : null,
    companyNameFallback: job.companyName,
    board,
    jobInteraction: {
      status: i.status,
      closeReason: i.closeReason ?? null,
      closeNote: i.closeNote ?? null,
      deferReason: i.deferReason ?? null,
      deferNote: i.deferNote ?? null,
      applyChannel: i.applyChannel ?? null,
      // Application date for an APPLIED job aging without a response. Events are
      // ordered occurredAt-desc, so the first APPLIED is the latest one.
      appliedAt:
        i.status === "APPLIED"
          ? (i.events
              .find((e) => e.type === "APPLIED")
              ?.occurredAt.toISOString() ?? null)
          : null,
      // When the role ended. DELISTED dates off Job.closedAt — the global
      // takedown date, and the authority (its JobEvent isn't fetched here);
      // CLOSED/REJECTED (withdrawals log a WITHDRAWN event) use the latest
      // terminal event.
      closedAt:
        i.status === "DELISTED"
          ? (job.closedAt?.toISOString() ?? null)
          : i.status === "CLOSED" || i.status === "REJECTED"
            ? (i.events
                .find(
                  (e) =>
                    e.type === "CLOSED" ||
                    e.type === "REJECTED" ||
                    e.type === "WITHDRAWN",
                )
                ?.occurredAt.toISOString() ?? null)
            : null,
      opportunity: i.opportunity
        ? { id: i.opportunity.id, label: i.opportunity.label }
        : null,
      coverLetter: i.coverLetter,
      shortAnswers: (i.shortAnswers as ShortAnswer[] | null) ?? null,
      coverLetterReuse: i.coverLetterReuse,
      shortAnswersReuse:
        (i.shortAnswersReuse as (boolean | null)[] | null) ?? null,
      events: i.events.map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt.toISOString(),
        notes: e.notes,
      })),
    },
  };
}
