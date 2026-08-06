// The job detail page — the payload the right panel and chat store render, plus
// the loader that builds it.

import { companyLogoUrl } from "@/lib/companyLogo";
import { prisma } from "@/server/db/prisma";
import { loadMergedQuestions } from "@/server/entities/jobs/applicationQuestions";
import { flipDueInterviewsToDebrief } from "@/server/entities/jobs/flipDueInterviews";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import type { ShortAnswer } from "@/server/entities/jobs/types";
import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
} from "@/server/scrape/types";

export type EventView = {
  id: string;
  type: string;
  occurredAt: string;
  notes: string | null;
};

export type FocusedJobView = {
  id: string;
  title: string;
  sourceUrl: string | null;
  description: string | null; // Job.rawContent — full posting text
  // Structured metadata pulled from the ATS API (Greenhouse / Lever / Ashby)
  // or extracted by the LLM scrape. Null when the source didn't provide it.
  // Rendered as a muted bullet-separated row in the job-detail header so the
  // user can see comp / location at a glance without scrolling the posting.
  location: string | null;
  department: string | null;
  compensation: string | null;
  employmentType: string | null;
  // Greenhouse-scraped application form, lazy-fetched on first ensureApplicationForm.
  // null = not attempted yet; other states = see ApplicationQuestionsEnvelope.
  applicationQuestions: ApplicationQuestionsEnvelope | null;
  // logoUrl is the resolved company logo (override or auto-derived) so the
  // job-detail header can render the same chip the dashboard / company page
  // show — keeps brand identity visible while drilling into a job.
  //
  // null when this Job is an unaffiliated pitched role (no company on the
  // watchlist yet). In that case `companyNameFallback` carries the human-
  // readable name the agent captured from the recruiter.
  company: { id: string; name: string; logoUrl: string } | null;
  companyNameFallback: string | null;
  jobInteraction: {
    status: string;
    // Populated only when status=CLOSED. Mirrors the company-page
    // skipped-rows treatment: render a banner under the header with the
    // reason + freeform note.
    closeReason: string | null;
    closeNote: string | null;
    // Populated only when status=DEFERRED ("could apply, outranked for now").
    deferReason: string | null;
    deferNote: string | null;
    // Populated for APPLIED rows (and onwards). Null for pre-feature APPLIED
    // rows and for any status before APPLIED. RECRUITER / REFERRAL render as
    // a small caption next to the status pill; DIRECT is implicit (no chip).
    applyChannel: "DIRECT" | "RECRUITER" | "REFERRAL" | null;
    // Application date for an APPLIED job aging without a response (drives the
    // escalating pill color + "Applied …" caption); null otherwise.
    appliedAt: string | null;
    // When the role ended, for terminal rows: the CLOSED/REJECTED/WITHDRAWN
    // event date, or Job.closedAt for DELISTED. Null for non-terminal rows.
    closedAt: string | null;
    // Set when this JobInteraction was created or attached via an inbound
    // Opportunity (a recruiter pitch / referral conversation). Drives the
    // "← Pitched via <lead label>" chip on the JobDetailView — clicking it
    // jumps back to the lead. Null for scan-flow / referral-direct jobs.
    opportunity: { id: string; label: string } | null;
    coverLetter: string | null;
    shortAnswers: ShortAnswer[] | null;
    // "Used" stamps (ISO) — non-null once the user copied/edited the artifact.
    // null = agent draft the user hasn't touched. Drives whether the reuse
    // switch is offered (an unused draft doesn't feed drafting regardless).
    // "Include in profile" reuse toggles (tri-state). null ⇒ derive from
    // used-state; true/false ⇒ explicit opt-in/out. shortAnswersReuse is the
    // parallel array (null index ⇒ derive that answer from its used-state).
    coverLetterReuse: boolean | null;
    shortAnswersReuse: (boolean | null)[] | null;
    events: EventView[];
  };
};

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
      title: true,
      sourceUrl: true,
      rawContent: true,
      ...ROLE_ATTR_SELECT,
      // applicationQuestions + userAddedQuestions are read (and merged) by
      // loadMergedQuestions below, not selected here.
      companyName: true,
      closedAt: true,
      company: {
        select: { id: true, name: true, sourceUrl: true, logoUrl: true },
      },
      jobInteractions: {
        where: { userId },
        select: {
          status: true,
          closeReason: true,
          closeNote: true,
          deferReason: true,
          deferNote: true,
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
    title: job.title,
    sourceUrl: job.sourceUrl,
    description: job.rawContent,
    ...toRoleAttrs(job),
    applicationQuestions,
    company: job.company
      ? {
          id: job.company.id,
          name: job.company.name,
          logoUrl: companyLogoUrl(job.company.sourceUrl, job.company.logoUrl),
        }
      : null,
    companyNameFallback: job.companyName,
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
