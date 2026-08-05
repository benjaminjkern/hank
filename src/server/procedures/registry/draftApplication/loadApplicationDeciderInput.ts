// The two halves of preparing an application form for the decider: splitting it
// into what the model judges vs what's already decided, and reading everything
// the prompt shows.
//
// The PARTITION stays on the caller's side of the sub-agent seam even though it
// shapes the prompt, because its output isn't only prompt input — the fields it
// removes get a FINAL persisted verdict here, and when it removes everything
// (a form of nothing but dropdowns) there's no LLM call to make at all. It's
// exported because the regression harness has to partition exactly as production
// does or it grades a question set prod would never send.

import { prisma } from "@/server/db/prisma";
import { loadPastDrafts } from "@/server/entities/jobs/pastDrafts";
import {
  ROLE_ATTR_SELECT,
  toRoleAttrs,
} from "@/server/entities/jobs/roleAttrs";
import { readResumeBackground } from "@/server/entities/resume/store";
import { readMemory } from "@/server/memory/store";
import {
  isStockFieldType,
  isCoverLetterQuestion,
  type ApplicationQuestion,
} from "@/server/scrape/types";
import type {
  ApplicationDeciderInput,
  QuestionDecision,
} from "@/server/subagents/registry/applicationDecider";

export type FormPartition = {
  // The questions the sub-agent decides, in order.
  draftable: ApplicationQuestion[];
  // Verdicts for the fields it never sees — already final, merged into the
  // persisted decision alongside whatever the model returns.
  stockDecisions: QuestionDecision[];
  // The full ordered form minus the cover-letter question, which routes to the
  // cover-letter path instead of being drafted as a generic short answer.
  questions: ApplicationQuestion[];
};

// The definitely-structured fields (selects, checkboxes, ratings, phone — by
// widget TYPE) have no prose answer by construction, so they're pre-skipped
// rather than spent as tokens. That's structural, not a guess: nothing is
// classified by its question TEXT, and a stock-looking `text`/`textarea` field
// goes to the model, which reads the wording and decides.
export function partitionApplicationForm(
  allQuestions: ApplicationQuestion[],
): FormPartition {
  const questions = allQuestions.filter(
    (q) => !isCoverLetterQuestion(q.question),
  );
  return {
    questions,
    draftable: questions.filter((q) => !isStockFieldType(q.type)),
    stockDecisions: questions
      .filter((q) => isStockFieldType(q.type))
      .map((q) => ({
        question: q.question,
        verdict: "skip" as const,
        reason: "",
      })),
  };
}

export type ApplicationDeciderInputLoad =
  { ok: true; input: ApplicationDeciderInput } | { ok: false; error: string };

export async function loadApplicationDeciderInput(args: {
  userId: string;
  jobId: string;
  draftable: ApplicationQuestion[];
  allQuestions: ApplicationQuestion[];
  formWantsCoverLetter: boolean;
}): Promise<ApplicationDeciderInputLoad> {
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
    input: {
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
      draftable: args.draftable,
      allQuestions: args.allQuestions,
      formWantsCoverLetter: args.formWantsCoverLetter,
    },
  };
}
