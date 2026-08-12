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

import {
  setDraftEntry,
  readProposedDrafts,
  readReuseFlags,
  readShortAnswers,
  type ApplicationItemRef,
  type DraftAuthor,
} from "./applicationDrafts";
import { COVER_LETTER_ID, questionId } from "./applicationItemId";
import { readApplicationReview } from "./applicationReview";
import {
  readStoredUserQuestions,
  writeStoredUserQuestions,
} from "./userAddedQuestions";

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
// A removed entry is still stored until the relay reports it, so every read of
// the FORM has to skip it — it isn't a question any more.
function readUserAddedQuestions(raw: unknown): ApplicationQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    if (typeof o.question !== "string" || !o.question.trim()) return [];
    if (typeof o.removedAt === "string") return [];
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
        ...(typeof o.relayedAt === "string" ? { relayedAt: o.relayedAt } : {}),
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
// provenance (who/when), deduped by normalizeForCompare against both the scraped
// form and existing user-added entries. Returns the question's id.
//
// It deliberately does NOT touch anyone's cached draftDecision. Clearing it to
// force a re-decide threw away every other question's verdict to add one, and
// the application page reads those verdicts to decide which questions it can
// file under "you fill these in yourself" — so adding one question made a dozen
// already-triaged ones reappear with editors. Staleness is detected instead:
// `decisionCoversForm` re-decides when the cached decision no longer covers the
// live form, which also catches a re-scrape that added questions, and does it
// for EVERY user rather than only the one who typed.
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

  await prisma.job.update({
    where: { id: jobId },
    data: { userAddedQuestions: next as unknown as Prisma.InputJsonValue },
  });
  return { ok: true, id: questionId(question), alreadyPresent: false };
}

export type RenameUserQuestionResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found" | "not_yours" | "duplicate" };

export type RemoveUserQuestionResult =
  { ok: true } | { ok: false; reason: "not_found" | "not_yours" };

// Take back a question the user described by hand — it wasn't on the form after
// all, or it was a duplicate of one that was. Same ownership rule as the reword:
// a scraped question is what the form says, and someone else's isn't yours to
// delete.
//
// The answer goes with it. A question's wording is the key its answer is stored
// under, so an answer left behind detaches and resurfaces on the page as an
// orphan item — which reads as the removal not having worked. Everything else
// keyed by that wording (Hank's baseline, his verdict, the author stamp, any
// open review finding) goes for the same reason.
export async function removeUserQuestion(
  userId: string,
  jobId: string,
  question: string,
): Promise<RemoveUserQuestionResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { userAddedQuestions: true },
  });
  if (!job) return { ok: false, reason: "not_found" };

  const stored = readStoredUserQuestions(job.userAddedQuestions);
  const norm = normalizeForCompare(question);
  const idx = stored.findIndex((q) => normalizeForCompare(q.question) === norm);
  if (idx < 0) return { ok: false, reason: "not_found" };
  if (stored[idx].addedByUserId !== userId) {
    return { ok: false, reason: "not_yours" };
  }

  const interaction = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: {
      shortAnswers: true,
      shortAnswersReuse: true,
      proposedDrafts: true,
      relayedDrafts: true,
      draftDecision: true,
      applicationReview: true,
    },
  });

  // A question Hank has been told about leaves a tombstone rather than vanishing:
  // he's holding a form item that no longer exists, and the relay derives what
  // to report from state, so a hard delete would leave nothing to derive from.
  // One he never heard about just goes.
  const wasRelayed = !!stored[idx].relayedAt;
  const nextStored = wasRelayed
    ? stored.map((q, i) =>
        i === idx ? { ...q, removedAt: nowDate().toISOString() } : q,
      )
    : stored.filter((_, i) => i !== idx);

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        userAddedQuestions: nextStored as unknown as Prisma.InputJsonValue,
      },
    }),
    ...(interaction
      ? [
          prisma.jobInteraction.update({
            where: { userId_jobId: { userId, jobId } },
            data: dropQuestion(interaction, norm, stored[idx].question),
          }),
        ]
      : []),
  ]);
  return { ok: true };
}

// The mirror of rekeyQuestion: unpick every place this user's row names the
// question by its text, rather than re-pointing them.
function dropQuestion(
  row: {
    shortAnswers: Prisma.JsonValue | null;
    shortAnswersReuse: Prisma.JsonValue | null;
    proposedDrafts: Prisma.JsonValue | null;
    relayedDrafts: Prisma.JsonValue | null;
    draftDecision: Prisma.JsonValue | null;
    applicationReview: Prisma.JsonValue | null;
  },
  norm: string,
  question: string,
): Prisma.JobInteractionUpdateInput {
  const isIt = (entry: { question: string }) =>
    normalizeForCompare(entry.question) === norm;
  const data: Prisma.JobInteractionUpdateInput = {};

  // The reuse flags are a parallel array, so the answer and its flag have to be
  // dropped at the same index or every flag after it shifts onto the wrong
  // answer.
  const answers = readShortAnswers(row.shortAnswers);
  const at = answers.findIndex(isIt);
  if (at >= 0) {
    const flags = readReuseFlags(row.shortAnswersReuse);
    while (flags.length < answers.length) flags.push(null);
    data.shortAnswers = answers.filter((_, i) => i !== at);
    data.shortAnswersReuse = flags.filter((_, i) => i !== at);
  }

  for (const col of ["proposedDrafts", "relayedDrafts"] as const) {
    const drafts = readProposedDrafts(row[col]);
    if (drafts?.answers.some(isIt)) {
      data[col] = {
        ...drafts,
        answers: drafts.answers.filter((a) => !isIt(a)),
      } as unknown as Prisma.InputJsonValue;
    }
  }

  const decision = row.draftDecision as {
    questions?: { question: string }[];
  } | null;
  if (decision?.questions?.some(isIt)) {
    data.draftDecision = {
      ...decision,
      questions: decision.questions.filter((q) => !isIt(q)),
    } as unknown as Prisma.InputJsonValue;
  }

  // Removing the question removes its answer, so any finding against it is an
  // objection to text that no longer exists anywhere. Nothing else drops a
  // finding by hand — settling is derived from whether the words are still
  // there — but this one has no words left to compare against.
  const review = readApplicationReview(row.applicationReview);
  if (review?.open.some((f) => f.itemId === questionId(question))) {
    data.applicationReview = {
      ...review,
      open: review.open.filter((f) => f.itemId !== questionId(question)),
    } as unknown as Prisma.InputJsonValue;
  }

  return data;
}

// Reword a question the user described by hand. Only the person who added it
// may — a scraped question is what the form actually says, and someone else's
// wording isn't yours to change.
//
// The question text IS the key every answer is stored under (see
// applicationItemId), so a rename has to carry this user's saved answer, Hank's
// baseline, and the cached verdict across with it or the answer detaches and
// resurfaces as an orphan. Other users of the same posting keep answers under
// the old wording; those degrade to the orphan-answer path loadApplicationView
// already renders, which is the honest outcome — their answer is still theirs,
// it just no longer matches a question on the form.
export async function renameUserQuestion(
  userId: string,
  jobId: string,
  currentQuestion: string,
  nextQuestion: string,
): Promise<RenameUserQuestionResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { applicationQuestions: true, userAddedQuestions: true },
  });
  if (!job) return { ok: false, reason: "not_found" };

  const stored = readStoredUserQuestions(job.userAddedQuestions);
  const currentNorm = normalizeForCompare(currentQuestion);
  const idx = stored.findIndex(
    (q) => normalizeForCompare(q.question) === currentNorm,
  );
  if (idx < 0) return { ok: false, reason: "not_found" };
  if (stored[idx].addedByUserId !== userId) {
    return { ok: false, reason: "not_yours" };
  }

  const nextNorm = normalizeForCompare(nextQuestion);
  if (nextNorm !== currentNorm) {
    const envelope =
      (job.applicationQuestions as ApplicationQuestionsEnvelope | null) ?? null;
    const taken = new Set([
      ...(envelope?.status === "ok" && Array.isArray(envelope.questions)
        ? envelope.questions.map((q) => normalizeForCompare(q.question))
        : []),
      ...stored
        .filter((_, i) => i !== idx)
        .map((q) => normalizeForCompare(q.question)),
    ]);
    if (taken.has(nextNorm)) return { ok: false, reason: "duplicate" };
  }

  const next = stored.map((q, i) =>
    i === idx
      ? // relayedAt is dropped: a reworded question is a change Hank hasn't
        // been told about, exactly like a new one.
        { ...q, question: nextQuestion, relayedAt: undefined }
      : q,
  );

  const interaction = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: {
      shortAnswers: true,
      proposedDrafts: true,
      relayedDrafts: true,
      draftDecision: true,
    },
  });

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { userAddedQuestions: next as unknown as Prisma.InputJsonValue },
    }),
    ...(interaction
      ? [
          prisma.jobInteraction.update({
            where: { userId_jobId: { userId, jobId } },
            data: rekeyQuestion(interaction, currentNorm, nextQuestion),
          }),
        ]
      : []),
  ]);
  return { ok: true, id: questionId(nextQuestion) };
}

// Re-point every place this user's row names a question by its text. Each is a
// JSON blob keyed by wording, so all three move together or the rename splits
// the answer from its question.
function rekeyQuestion(
  row: {
    shortAnswers: Prisma.JsonValue | null;
    proposedDrafts: Prisma.JsonValue | null;
    relayedDrafts: Prisma.JsonValue | null;
    draftDecision: Prisma.JsonValue | null;
  },
  currentNorm: string,
  nextQuestion: string,
): Prisma.JobInteractionUpdateInput {
  const rename = <T extends { question: string }>(entry: T): T =>
    normalizeForCompare(entry.question) === currentNorm
      ? { ...entry, question: nextQuestion }
      : entry;

  const data: Prisma.JobInteractionUpdateInput = {};

  const answers = readShortAnswers(row.shortAnswers);
  if (answers.some((a) => normalizeForCompare(a.question) === currentNorm)) {
    data.shortAnswers = answers.map(rename);
  }

  // Both baselines are keyed by wording, so both move or the rename splits the
  // answer from what it's compared against.
  for (const col of ["proposedDrafts", "relayedDrafts"] as const) {
    const drafts = readProposedDrafts(row[col]);
    if (
      drafts?.answers.some(
        (a) => normalizeForCompare(a.question) === currentNorm,
      )
    ) {
      data[col] = {
        ...drafts,
        answers: drafts.answers.map(rename),
      } as unknown as Prisma.InputJsonValue;
    }
  }

  const decision = row.draftDecision as {
    questions?: { question: string }[];
  } | null;
  if (
    decision?.questions?.some(
      (q) => normalizeForCompare(q.question) === currentNorm,
    )
  ) {
    data.draftDecision = {
      ...decision,
      questions: decision.questions.map(rename),
    } as unknown as Prisma.InputJsonValue;
  }

  return data;
}

// The merge-upsert for one application item: replaces the cover letter and/or
// upserts one short answer WITHOUT disturbing siblings.
//
// `author` says whose words these are, and it decides which baselines move.
// Hank's own text moves both (it's his, and he's seen it) and clears reuse —
// nothing he drafts feeds his next draft until the user opts it in. The user's
// dictated words move only the seen baseline and leave reuse exactly as it was:
// the switch lives on the page, and a chat message can't flip a control the
// user isn't looking at.
export async function persistApplicationAnswer(
  userId: string,
  jobId: string,
  input: {
    coverLetter?: string;
    question?: string;
    answer?: string;
    author: DraftAuthor;
  },
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
      proposedDrafts: true,
      relayedDrafts: true,
      applicationReview: true,
      job: { select: { slug: true } },
    },
  });
  if (!jobInteraction) return { ok: false, reason: "no_job_interaction" };
  const jobSlug = jobInteraction.job?.slug ?? jobId;

  // Hank's own writing moves the "whose words" baseline; the user's dictated
  // words must not, or their text would read back as his. Both move the "seen"
  // baseline — he wrote one and just transcribed the other, so neither is an
  // unsent change for him to be told about.
  const byHank = input.author === "hank";
  let written: Prisma.JsonValue = jobInteraction.proposedDrafts;
  let seen: Prisma.JsonValue = jobInteraction.relayedDrafts;
  const recordDraft = (item: ApplicationItemRef, text: string) => {
    if (byHank) {
      written = setDraftEntry(written, item, text) as Prisma.JsonValue;
      data.proposedDrafts = written as Prisma.InputJsonValue;
    }
    seen = setDraftEntry(seen, item, text) as Prisma.JsonValue;
    data.relayedDrafts = seen as Prisma.InputJsonValue;
  };
  const applied: string[] = [];
  const data: {
    coverLetter?: string;
    coverLetterReuse?: boolean;
    shortAnswers?: Prisma.InputJsonValue;
    shortAnswersReuse?: Prisma.InputJsonValue;
    proposedDrafts?: Prisma.InputJsonValue;
    relayedDrafts?: Prisma.InputJsonValue;
  } = {};

  if (input.coverLetter?.trim()) {
    data.coverLetter = input.coverLetter;
    // Only Hank's own drafting touches the flag, and only to clear it: nothing
    // he writes feeds his next draft until the user opts in. A verbatim save
    // leaves it exactly as it was — the switch lives on the page, and flipping
    // it from a chat message would be a change nobody could see happen.
    if (byHank) data.coverLetterReuse = false;
    recordDraft({ kind: "cover_letter" }, input.coverLetter);
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
      if (byHank) reuse[idx] = false;
    } else {
      existing.push({ question: canonical, answer: input.answer });
      reuse.push(byHank ? false : null);
    }
    data.shortAnswers = existing;
    data.shortAnswersReuse = reuse;
    recordDraft({ kind: "question", question: canonical }, input.answer);
    applied.push("short answer");
  }

  await prisma.jobInteraction.update({
    where: { userId_jobId: { userId, jobId } },
    data,
  });
  return { ok: true, applied, jobSlug };
}
