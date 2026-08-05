// Job-entity application-question service — the read/merge/write path over a
// Job's application form. Consumed by the four drafting tools, the drafting
// procedure, the walkthrough state machine, the decider, and the job-detail
// loader (getFocusedJobView), so they can't drift.
//
// Three concerns live here:
//
//  1. Merging the SCRAPED form (Job.applicationQuestions) with the USER-ADDED
//     set (Job.userAddedQuestions — questions a person described by hand when
//     the ATS form couldn't be read). Both are GLOBAL on the Job; user-added
//     entries carry provenance (addedByUserId/addedAt) and read back tagged
//     `source:"user"` so the UI can badge them unverified. `loadMergedQuestions`
//     is the single read path; `addUserQuestion` the single write path.
//  2. `persistApplicationAnswer` — the merge-upsert that saves one answer
//     (cover letter and/or one short answer), extracted from
//     save_application_answer so that tool and draft_application_question share
//     exactly one persistence path.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  isCoverLetterQuestion,
  type ApplicationQuestion,
  type ApplicationQuestionsEnvelope,
} from "@/server/scrape/types";
import { nowDate } from "@/utils/now";
import { normalizeForCompare } from "@/utils/text";

import { proposedDraftsPatch } from "./applicationDrafts";
import { COVER_LETTER_ID, questionId } from "./applicationItemId";

type QuestionSource = "scraped" | "user";
type MergedQuestion = ApplicationQuestion & {
  id: string;
  source: QuestionSource;
};

type MergedQuestions = {
  // Raw scraped envelope (null = never fetched).
  envelope: ApplicationQuestionsEnvelope | null;
  // Scraped form questions (empty unless envelope.status === "ok").
  scrapedQuestions: ApplicationQuestion[];
  // User-contributed questions (Job.userAddedQuestions), tagged source:"user".
  userAddedQuestions: ApplicationQuestion[];
  // scraped ++ user, deduped by normalizeForCompare (scraped wins), each id- and
  // source-tagged. Includes any cover-letter-labeled question; consumers filter
  // via isCoverLetterQuestion.
  merged: MergedQuestion[];
  // The form (or a user-added "cover letter" question) wants a cover letter.
  formWantsCoverLetter: boolean;
  // The scrape failed (unsupported/error) AND nobody has added a question by
  // hand — genuinely nothing to draft from. A user-added overlay makes the form
  // "available" again even when the scrape didn't work.
  formUnavailable: boolean;
  // The ATS form has NEVER been fetched (envelope === null) AND nobody described
  // it by hand. DISTINCT from formUnavailable (fetched, couldn't read) and from a
  // fetched-empty form ({status:"empty"}). This is the load-bearing distinction
  // for the "Hank confidently said there are no questions" bug: a null envelope
  // must NOT be reported as "no questions" — it means "not read yet". Any surface
  // that reports form state to the user gates on this before saying anything.
  formNeverFetched: boolean;
};

// Parse Job.userAddedQuestions JSON into ApplicationQuestion[], preserving
// provenance and tagging source:"user".
function readUserAddedQuestions(raw: unknown): ApplicationQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    if (typeof o.question !== "string" || !o.question.trim()) return [];
    return [
      {
        question: o.question,
        ...(typeof o.type === "string" ? { type: o.type } : {}),
        ...(typeof o.required === "boolean" ? { required: o.required } : {}),
        source: "user" as const,
        ...(typeof o.addedByUserId === "string"
          ? { addedByUserId: o.addedByUserId }
          : {}),
        ...(typeof o.addedAt === "string" ? { addedAt: o.addedAt } : {}),
      },
    ];
  });
}

export async function loadMergedQuestions(
  jobId: string,
): Promise<MergedQuestions> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { applicationQuestions: true, userAddedQuestions: true },
  });
  const envelope =
    (job?.applicationQuestions as ApplicationQuestionsEnvelope | null) ?? null;
  const scrapedQuestions: ApplicationQuestion[] =
    envelope?.status === "ok" && Array.isArray(envelope.questions)
      ? envelope.questions.map((q) => ({ ...q, source: "scraped" as const }))
      : [];
  const userAddedQuestions = readUserAddedQuestions(job?.userAddedQuestions);

  const seen = new Set(
    scrapedQuestions.map((q) => normalizeForCompare(q.question)),
  );
  const merged: MergedQuestion[] = [
    ...scrapedQuestions.map((q) => ({
      ...q,
      id: questionId(q.question),
      source: "scraped" as const,
    })),
    ...userAddedQuestions
      .filter((q) => !seen.has(normalizeForCompare(q.question)))
      .map((q) => ({
        ...q,
        id: questionId(q.question),
        source: "user" as const,
      })),
  ];

  const hasCoverLetterQuestion = merged.some((q) =>
    isCoverLetterQuestion(q.question),
  );
  const formWantsCoverLetter =
    ((envelope?.status === "ok" || envelope?.status === "empty") &&
      envelope.coverLetter === true) ||
    hasCoverLetterQuestion;

  const scrapeFailed =
    envelope?.status === "unsupported" || envelope?.status === "error";
  const formUnavailable = scrapeFailed && userAddedQuestions.length === 0;
  const formNeverFetched = envelope === null && userAddedQuestions.length === 0;

  return {
    envelope,
    scrapedQuestions,
    userAddedQuestions,
    merged,
    formWantsCoverLetter,
    formUnavailable,
    formNeverFetched,
  };
}

type ResolvedQuestion =
  { kind: "cover_letter" } | { kind: "question"; text: string };

// Resolve a tool-facing questionId back to what it drafts. `cover_letter` →
// the cover-letter track; a `q_…` id → the underlying question text (matched in
// the merged scraped+user set). null when the id doesn't match anything.
export async function resolveQuestionId(
  jobId: string,
  id: string,
): Promise<ResolvedQuestion | null> {
  if (id === COVER_LETTER_ID) return { kind: "cover_letter" };
  const { merged } = await loadMergedQuestions(jobId);
  const found = merged.find((q) => q.id === id);
  return found ? { kind: "question", text: found.question } : null;
}

// Append a user-described question to the GLOBAL Job.userAddedQuestions with
// provenance (who/when), deduped by normalizeForCompare against both the scraped form
// and existing user-added entries. Also nulls the ADDING user's cached
// draftDecision so the new question is included next whole-form pass (other
// users pick it up when their decision next re-runs). Returns the question's id.
export async function addUserQuestion(
  userId: string,
  jobId: string,
  question: string,
  type: string | undefined,
): Promise<{ ok: true; id: string; alreadyPresent: boolean } | { ok: false }> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { applicationQuestions: true, userAddedQuestions: true },
  });
  if (!job) return { ok: false };

  const envelope =
    (job.applicationQuestions as ApplicationQuestionsEnvelope | null) ?? null;
  const scrapedNorm = new Set(
    envelope?.status === "ok" && Array.isArray(envelope.questions)
      ? envelope.questions.map((q) => normalizeForCompare(q.question))
      : [],
  );
  const existingRaw = Array.isArray(job.userAddedQuestions)
    ? (job.userAddedQuestions as unknown[])
    : [];
  const existingNorm = new Set(
    readUserAddedQuestions(existingRaw).map((q) =>
      normalizeForCompare(q.question),
    ),
  );

  const norm = normalizeForCompare(question);
  if (scrapedNorm.has(norm) || existingNorm.has(norm)) {
    return { ok: true, id: questionId(question), alreadyPresent: true };
  }

  // Store WITHOUT the derived `source` field (it's injected at read time).
  const entry = {
    question,
    ...(type ? { type } : {}),
    addedByUserId: userId,
    addedAt: nowDate().toISOString(),
  };
  const next = [...existingRaw, entry];

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { userAddedQuestions: next as unknown as Prisma.InputJsonValue },
    }),
    // Force a re-decide for the adding user so the whole-form path sees it.
    prisma.jobInteraction.updateMany({
      where: { userId, jobId },
      data: { draftDecision: Prisma.DbNull },
    }),
  ]);
  return { ok: true, id: questionId(question), alreadyPresent: false };
}

// The merge-upsert for an application answer written BY HANK: replaces the cover
// letter and/or upserts one short answer WITHOUT disturbing siblings, and sets
// the item's reuse flag to FALSE — a Hank-authored/overwritten draft is never
// reuse-eligible until the user opts it in (copy / edit / flip the switch). Only
// the user marks reuse=true (frontend). Shared by save_application_answer and
// draft_application_question.
export async function persistApplicationAnswer(
  userId: string,
  jobId: string,
  input: { coverLetter?: string; question?: string; answer?: string },
): Promise<
  | { ok: true; applied: string[]; jobSlug: string }
  | { ok: false; reason: "no_job_interaction" }
> {
  const jobInteraction = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: {
      coverLetter: true,
      shortAnswers: true,
      shortAnswersReuse: true,
      job: { select: { slug: true } },
    },
  });
  if (!jobInteraction) return { ok: false, reason: "no_job_interaction" };
  const jobSlug = jobInteraction.job?.slug ?? jobId;

  const applied: string[] = [];
  const data: {
    coverLetter?: string;
    coverLetterReuse?: boolean;
    shortAnswers?: Prisma.InputJsonValue;
    shortAnswersReuse?: Prisma.InputJsonValue;
    proposedDrafts?: Prisma.InputJsonValue;
  } = {};

  if (input.coverLetter?.trim()) {
    data.coverLetter = input.coverLetter;
    data.coverLetterReuse = false;
    applied.push("cover letter");
  }

  if (input.question && input.answer) {
    // Canonicalize against the merged scraped+user set so the saved key matches
    // the walkthrough's answered-set check and the decider's verdict question.
    const { merged } = await loadMergedQuestions(jobId);
    const canonical =
      merged.find((q) => q.question === input.question)?.question ??
      merged.find(
        (q) =>
          normalizeForCompare(q.question) ===
          normalizeForCompare(input.question!),
      )?.question ??
      input.question;

    const existing = (
      Array.isArray(jobInteraction.shortAnswers)
        ? (jobInteraction.shortAnswers as Array<{
            question: string;
            answer: string;
          }>)
        : []
    ).slice();
    // Keep shortAnswersReuse parallel to shortAnswers (pad legacy gaps).
    const reuse = (
      Array.isArray(jobInteraction.shortAnswersReuse)
        ? (jobInteraction.shortAnswersReuse as Array<boolean | null>)
        : []
    ).slice();
    while (reuse.length < existing.length) reuse.push(null);

    const idx = existing.findIndex(
      (e) => normalizeForCompare(e.question) === normalizeForCompare(canonical),
    );
    if (idx >= 0) {
      existing[idx] = { question: canonical, answer: input.answer };
      reuse[idx] = false; // Hank overwrote it → not reusable until the user opts in
    } else {
      existing.push({ question: canonical, answer: input.answer });
      reuse.push(false);
    }
    data.shortAnswers = existing;
    data.shortAnswersReuse = reuse;
    applied.push("short answer");
  }

  // Re-baseline: this text is now what Hank has written and seen, so a later
  // panel edit diverges from THIS rather than from a stale draft.
  data.proposedDrafts = proposedDraftsPatch({
    coverLetter: data.coverLetter ?? jobInteraction.coverLetter,
    shortAnswers:
      (data.shortAnswers as Prisma.JsonValue | undefined) ??
      jobInteraction.shortAnswers,
  });

  await prisma.jobInteraction.update({
    where: { userId_jobId: { userId, jobId } },
    data,
  });
  return { ok: true, applied, jobSlug };
}
