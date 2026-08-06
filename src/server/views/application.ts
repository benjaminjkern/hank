// The application page — every item the form asks for, in form order, with
// what's written for it and who wrote it.
//
// One payload, three audiences: the panel renders it, `view_application_questions`
// reports it to Hank as a status list, and `read_application_drafts` reads the
// text back out of it. Undrafted questions are items too, carrying empty text —
// a form item Hank passed over has to be visible or the user can't fill it in.

import { JobInteractionStatus } from "@/generated/prisma/client";
import { companyLogoUrl } from "@/lib/companyLogo";
import { prisma } from "@/server/db/prisma";
import {
  isUserOwned,
  readProposedDrafts,
  readReuseFlags,
  readShortAnswers,
  type DraftedRow,
} from "@/server/entities/jobs/applicationDrafts";
import {
  COVER_LETTER_ID,
  questionId,
} from "@/server/entities/jobs/applicationItemId";
import { loadMergedQuestions } from "@/server/entities/jobs/applicationQuestions";
import { isCoverLetterQuestion } from "@/server/scrape/types";
import type {
  ApplicationDecision,
  DraftVerdict,
} from "@/server/subagents/registry/applicationDecider";
import { normalizeForCompare } from "@/utils/text";

export type ApplicationItemStatus =
  // The user wrote or reworked this text.
  | "written_by_you"
  // Hank's draft, untouched.
  | "drafted"
  // The decider wants the user's own input before anything is written.
  | "needs_you"
  // Nothing written. `note` says why, when Hank had a reason.
  | "empty";

export type ApplicationItem = {
  id: string;
  kind: "cover_letter" | "question";
  // "Cover letter", or the question as the form asks it.
  label: string;
  required: boolean;
  // "user" marks a question someone described by hand rather than one scraped
  // off the form — the panel badges it as unverified.
  source: "scraped" | "user";
  text: string | null;
  reuse: boolean | null;
  status: ApplicationItemStatus;
  // Diverges from what Hank last wrote, so it rides the next chat message.
  edited: boolean;
  // Hank's one-line reason for leaving this alone, shown under an empty item.
  note: string | null;
};

export type ApplicationView = {
  jobId: string;
  jobSlug: string | null;
  jobTitle: string;
  jobStatus: string;
  // The posting itself — where the user actually submits.
  postingUrl: string | null;
  company: { id: string; slug: string; name: string; logoUrl: string } | null;
  companyName: string;
  // Applied and onwards: the page stays editable (the text is reusable
  // elsewhere) but stops relaying edits and stops offering submit.
  submitted: boolean;
  // The form couldn't be read AND nobody described a question by hand.
  formUnreadable: boolean;
  // Read, and it genuinely asks nothing beyond the stock fields.
  formEmpty: boolean;
  // The form takes a cover letter (so the page offers one unprompted).
  wantsCoverLetter: boolean;
  items: ApplicationItem[];
  // Items whose text hasn't been relayed to Hank yet.
  pendingEditCount: number;
};

export async function loadApplicationView(
  userId: string,
  jobId: string,
): Promise<ApplicationView | null> {
  const merged = await loadMergedQuestions(jobId);
  const row = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: {
      status: true,
      draftDecision: true,
      coverLetter: true,
      coverLetterReuse: true,
      shortAnswers: true,
      shortAnswersReuse: true,
      proposedDrafts: true,
      job: {
        select: {
          id: true,
          slug: true,
          title: true,
          sourceUrl: true,
          companyName: true,
          company: {
            select: {
              id: true,
              slug: true,
              name: true,
              sourceUrl: true,
              logoUrl: true,
            },
          },
        },
      },
    },
  });
  if (!row) return null;

  const decision = (row.draftDecision as ApplicationDecision | null) ?? null;
  const verdictByQuestion = new Map<
    string,
    { verdict: DraftVerdict; reason: string }
  >();
  for (const qd of decision?.questions ?? []) {
    verdictByQuestion.set(normalizeForCompare(qd.question), {
      verdict: qd.verdict,
      reason: qd.reason,
    });
  }

  const answers = readShortAnswers(row.shortAnswers);
  const reuseFlags = readReuseFlags(row.shortAnswersReuse);
  const answerByQuestion = new Map(
    answers.map((a, i) => [
      normalizeForCompare(a.question),
      { text: a.answer, reuse: reuseFlags[i] ?? null },
    ]),
  );

  const items: ApplicationItem[] = [];

  // The cover letter leads, and is offered whenever the form takes one — or
  // whenever one already exists, so a letter written for an unreadable form
  // doesn't vanish off the page.
  const hasCoverLetter = (row.coverLetter ?? "").trim().length > 0;
  if (merged.formWantsCoverLetter || hasCoverLetter) {
    items.push(
      buildItem({
        id: COVER_LETTER_ID,
        kind: "cover_letter",
        label: "Cover letter",
        required: false,
        source: "scraped",
        text: row.coverLetter,
        reuse: row.coverLetterReuse,
        verdict: decision?.coverLetter?.verdict ?? null,
        note: decision?.coverLetter?.reason ?? null,
        owned: isUserOwned(row, { kind: "cover_letter" }),
        edited: isEdited(row, { kind: "cover_letter" }),
      }),
    );
  }

  for (const q of merged.merged) {
    // A cover-letter-labeled question IS the cover letter above, not a second
    // item asking for the same thing.
    if (isCoverLetterQuestion(q.question)) continue;
    const norm = normalizeForCompare(q.question);
    const answer = answerByQuestion.get(norm);
    const verdict = verdictByQuestion.get(norm);
    items.push(
      buildItem({
        id: q.id,
        kind: "question",
        label: q.question,
        required: !!q.required,
        source: q.source === "user" ? "user" : "scraped",
        text: answer?.text ?? null,
        reuse: answer?.reuse ?? null,
        verdict: verdict?.verdict ?? null,
        note: verdict?.reason ?? null,
        owned: isUserOwned(row, { kind: "question", question: q.question }),
        edited: isEdited(row, { kind: "question", question: q.question }),
      }),
    );
  }

  // An answer saved against a question the form no longer lists (the form was
  // re-fetched and changed, or it was saved by hand) still belongs to the user.
  const listed = new Set(items.map((i) => normalizeForCompare(i.label)));
  for (const a of answers) {
    if (listed.has(normalizeForCompare(a.question))) continue;
    items.push(
      buildItem({
        id: questionId(a.question),
        kind: "question",
        label: a.question,
        required: false,
        source: "user",
        text: a.answer,
        reuse:
          answerByQuestion.get(normalizeForCompare(a.question))?.reuse ?? null,
        verdict: null,
        note: null,
        owned: isUserOwned(row, { kind: "question", question: a.question }),
        edited: isEdited(row, { kind: "question", question: a.question }),
      }),
    );
  }

  const job = row.job;
  return {
    jobId: job.id,
    jobSlug: job.slug,
    jobTitle: job.title,
    jobStatus: row.status,
    postingUrl: job.sourceUrl,
    company: job.company
      ? {
          id: job.company.id,
          slug: job.company.slug,
          name: job.company.name,
          logoUrl: companyLogoUrl(job.company.sourceUrl, job.company.logoUrl),
        }
      : null,
    companyName: job.company?.name ?? job.companyName ?? "this company",
    submitted: SUBMITTED_STATUSES.includes(row.status),
    formUnreadable:
      (merged.formUnavailable || merged.formNeverFetched) &&
      merged.userAddedQuestions.length === 0,
    formEmpty: items.length === 0 && !merged.formNeverFetched,
    wantsCoverLetter: merged.formWantsCoverLetter,
    items,
    pendingEditCount: items.filter((i) => i.edited).length,
  };
}

// Everything from APPLIED onwards. The page is a record at that point: still
// editable, but no longer a thing Hank is being asked to work on.
const SUBMITTED_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.APPLIED,
  JobInteractionStatus.RESPONDED,
  JobInteractionStatus.WAITING_ON_RESPONSE,
  JobInteractionStatus.INTERVIEW_SCHEDULED,
  JobInteractionStatus.INTERVIEW_DEBRIEF,
  JobInteractionStatus.OFFERED,
  JobInteractionStatus.REJECTED,
  JobInteractionStatus.DELISTED,
];

function isEdited(
  row: DraftedRow,
  item: { kind: "cover_letter" } | { kind: "question"; question: string },
): boolean {
  const drafts = readProposedDrafts(row.proposedDrafts);
  if (item.kind === "cover_letter") {
    const base = drafts?.coverLetter ?? null;
    return (base ?? "").trim() !== (row.coverLetter ?? "").trim();
  }
  const norm = normalizeForCompare(item.question);
  const live = readShortAnswers(row.shortAnswers).find(
    (a) => normalizeForCompare(a.question) === norm,
  );
  const base = drafts?.answers.find(
    (a) => normalizeForCompare(a.question) === norm,
  );
  return (base?.text ?? "").trim() !== (live?.answer ?? "").trim();
}

function buildItem(input: {
  id: string;
  kind: "cover_letter" | "question";
  label: string;
  required: boolean;
  source: "scraped" | "user";
  text: string | null;
  reuse: boolean | null;
  verdict: DraftVerdict | null;
  note: string | null;
  owned: boolean;
  edited: boolean;
}): ApplicationItem {
  const hasText = (input.text ?? "").trim().length > 0;
  const status: ApplicationItemStatus = hasText
    ? input.owned
      ? "written_by_you"
      : "drafted"
    : input.verdict === "ask_user"
      ? "needs_you"
      : "empty";
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    required: input.required,
    source: input.source,
    text: input.text,
    reuse: input.reuse,
    status,
    edited: input.edited,
    // A reason only earns space when there's nothing written to read instead.
    note: hasText ? null : input.note?.trim() || null,
  };
}
