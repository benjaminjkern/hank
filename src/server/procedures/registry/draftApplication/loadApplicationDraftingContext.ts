// Everything the drafting sub-agent writes from: the role, the user's
// background and notes, and the catalog of their past applications.

import { prisma } from "@/server/db/prisma";
import { loadPastDrafts } from "@/server/entities/jobs/pastDrafts";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { readResumeBackground } from "@/server/entities/resume/store";
import { readMemory } from "@/server/memory/store";
import type { ApplicationDraftingContext } from "@/server/subagents/registry/applicationDrafting";

export type DraftingContext =
  | { ok: true; context: ApplicationDraftingContext }
  | { ok: false; error: string };

export async function loadApplicationDraftingContext(args: {
  userId: string;
  jobId: string;
}): Promise<DraftingContext> {
  const job = await prisma.job.findUnique({
    where: { id: args.jobId },
    select: {
      slug: true,
      title: true,
      rawContent: true,
      ...ROLE_ATTR_SELECT,
      attributes: true,
      companyName: true,
      company: { select: { name: true, slug: true, description: true } },
    },
  });
  if (!job) return { ok: false, error: `job ${args.jobId} not found` };

  // Address this job's note by its human slug, never a cuid.
  const jobNotePath = `jobs/${job.slug ?? args.jobId}.md`;
  const companyNotePath = job.company?.slug
    ? `companies/${job.company.slug}.md`
    : null;

  const [profile, frequentQuestions, companyNote, jobNote, resume, pastDrafts] =
    await Promise.all([
      readMemory(args.userId, "profile.md"),
      readMemory(args.userId, "frequent_questions.md"),
      companyNotePath
        ? readMemory(args.userId, companyNotePath)
        : Promise.resolve(null),
      readMemory(args.userId, jobNotePath),
      readResumeBackground(args.userId),
      loadPastDrafts(args.userId, args.jobId),
    ]);

  return {
    ok: true,
    context: {
      jobTitle: job.title,
      companyName: job.company?.name ?? job.companyName ?? "(unknown company)",
      ...toRoleAttrs(job),
      attributes: job.attributes,
      postingBody: job.rawContent,
      companyDescription: job.company?.description ?? null,
      companyNotePath,
      companyNote,
      jobNotePath,
      jobNote,
      resume,
      profile,
      frequentQuestions,
      pastDrafts,
    },
  };
}
