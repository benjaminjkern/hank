// Fetch + cache a job's application-form questions — step 1 of the
// draft-application procedure. Extracted from the get_application_form tool
// handler so BOTH the tool (agent-facing, formats the result) and the procedure
// delegate to one function instead of the procedure calling a tool handle.
//
// Lazy: only hits the ATS when needsQuestionsRefresh says the cached envelope is
// missing / stale ({status:"error"}, or a >24h {status:"unsupported"});
// otherwise it returns what's already on Job.applicationQuestions. Persists the
// fetched envelope. Job is global (not user-scoped), so this keys off jobId.

import { prisma } from "@/server/db/prisma";
import { needsQuestionsRefresh } from "@/server/entities/jobs/questionsRefresh";
import { fetchApplicationQuestions } from "@/server/scrape/ats";
import type { ApplicationQuestionsEnvelope } from "@/server/scrape/types";

type EnsureApplicationFormResult =
  | { status: "not_found" }
  | { status: "no_source_url"; jobTitle: string; companyLabel: string }
  | {
      status: "ready";
      jobTitle: string;
      companyLabel: string;
      sourceUrl: string;
      envelope: ApplicationQuestionsEnvelope | null;
    };

export async function ensureApplicationForm(args: {
  jobId: string;
}): Promise<EnsureApplicationFormResult> {
  const job = await prisma.job.findUnique({
    where: { id: args.jobId },
    select: {
      id: true,
      title: true,
      sourceUrl: true,
      applicationQuestions: true,
      companyName: true,
      company: { select: { name: true, greenhouseSlug: true } },
    },
  });
  if (!job) return { status: "not_found" };

  const companyLabel =
    job.company?.name ?? job.companyName ?? "(no company yet)";
  if (!job.sourceUrl) {
    return { status: "no_source_url", jobTitle: job.title, companyLabel };
  }

  // Lazy fetch + persist on first read; refresh stale {status:"error"}
  // envelopes so transient failures aren't sticky. "ok" / "empty" /
  // "unsupported" are permanent until invalidated explicitly.
  let envelope =
    job.applicationQuestions as ApplicationQuestionsEnvelope | null;
  if (needsQuestionsRefresh(envelope)) {
    envelope = await fetchApplicationQuestions(job.sourceUrl, {
      greenhouseSlug: job.company?.greenhouseSlug ?? null,
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        applicationQuestions: envelope,
      },
    });
  }

  return {
    status: "ready",
    jobTitle: job.title,
    companyLabel,
    sourceUrl: job.sourceUrl,
    envelope,
  };
}
