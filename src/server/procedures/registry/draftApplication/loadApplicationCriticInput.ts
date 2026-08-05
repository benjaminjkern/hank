// Assembles what the application critic reviews: the posting, the resume, and
// the candidate's other applications to the same company.
//
// The critic is a "fresh reader" by construction — a transform sub-agent with
// no read tools — so this function IS the complete definition of what the
// reviewer knows. Anything not returned here is invisible to it, which is the
// point: no user memory, no thesis, no notes.

import { JobEventType } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { readResumeBackground } from "@/server/entities/resume/store";
import type {
  ApplicationCriticInput,
  SiblingApplication,
} from "@/server/subagents/registry/applicationCritic";
import { relativeTime } from "@/utils/date";

// How many sibling applications to scan before ranking, and how many to show.
const SIBLING_SCAN_LIMIT = 20;
const SIBLING_SHOW_LIMIT = 5;

export async function loadApplicationCriticInput(args: {
  userId: string;
  jobId: string;
  coverLetter: string | null;
  shortAnswers: Array<{ question: string; answer: string }>;
}): Promise<
  { ok: true; input: ApplicationCriticInput } | { ok: false; error: string }
> {
  const job = await prisma.job.findUnique({
    where: { id: args.jobId },
    select: {
      id: true,
      title: true,
      rawContent: true,
      ...ROLE_ATTR_SELECT,
      attributes: true,
      companyName: true,
      company: { select: { id: true, name: true, description: true } },
    },
  });
  if (!job) return { ok: false, error: `job ${args.jobId} not found` };

  const [resume, siblings] = await Promise.all([
    readResumeBackground(args.userId),
    job.company?.id
      ? loadSiblingApplications(args.userId, job.company.id, args.jobId)
      : Promise.resolve<SiblingApplication[]>([]),
  ]);

  return {
    ok: true,
    input: {
      jobTitle: job.title,
      companyName: job.company?.name ?? job.companyName ?? "(unknown company)",
      posting: {
        ...toRoleAttrs(job),
        attributes: job.attributes,
        body: job.rawContent,
        companyDescription: job.company?.description ?? null,
      },
      coverLetter: args.coverLetter,
      shortAnswers: args.shortAnswers,
      resume,
      siblings,
    },
  };
}

// The candidate's other applications to the SAME company — what a recruiter on
// that side would already have on file.
//
// "They applied" is an EVENT, not a status: RESPONDED / INTERVIEW_* / OFFERED /
// REJECTED / applied-then-withdrawn all imply an APPLIED event, so one predicate
// covers them and no status flip can strand it. Draft state is the wrong signal
// — a user who applied through the company's portal never marks a draft used,
// and a draft they copied but never sent isn't something the recruiter read.
async function loadSiblingApplications(
  userId: string,
  companyId: string,
  excludeJobId: string,
): Promise<SiblingApplication[]> {
  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId,
      NOT: { jobId: excludeJobId },
      job: { companyId },
      events: { some: { type: JobEventType.APPLIED } },
    },
    // Deterministic cut for the scan cap; the real ordering is by apply date
    // below, which Prisma can't sort on through the relation.
    orderBy: { updatedAt: "desc" },
    take: SIBLING_SCAN_LIMIT,
    select: {
      status: true,
      closeReason: true,
      coverLetter: true,
      shortAnswers: true,
      job: {
        select: {
          title: true,
          ...ROLE_ATTR_SELECT,
        },
      },
      events: {
        where: { type: JobEventType.APPLIED },
        orderBy: { occurredAt: "desc" },
        take: 1,
        select: { occurredAt: true },
      },
    },
  });

  return (
    rows
      // The where-clause guarantees an APPLIED event; the guard is for the type.
      .flatMap((r) => {
        const appliedAt = r.events[0]?.occurredAt;
        return appliedAt ? [{ r, appliedAt }] : [];
      })
      .sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime())
      .slice(0, SIBLING_SHOW_LIMIT)
      .map(({ r, appliedAt }) => ({
        jobTitle: r.job?.title ?? "(unknown role)",
        ...toRoleAttrs(r.job),
        appliedAgo: relativeTime(appliedAt),
        status: r.status,
        closeReason: r.closeReason,
        // Every artifact still on an applied row is part of what was sent:
        // markJobApplied wipes the drafts the user never touched at APPLIED time,
        // so no per-artifact used-gating is needed here.
        coverLetter: r.coverLetter?.trim() || null,
        shortAnswers: readShortAnswers(r.shortAnswers),
      }))
  );
}

function readShortAnswers(
  raw: unknown,
): Array<{ question: string; answer: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ question: string; answer: string }> = [];
  for (const entry of raw as Array<{ question?: unknown; answer?: unknown }>) {
    const question =
      typeof entry?.question === "string" ? entry.question.trim() : "";
    const answer = typeof entry?.answer === "string" ? entry.answer.trim() : "";
    if (question && answer) out.push({ question, answer });
  }
  return out;
}
