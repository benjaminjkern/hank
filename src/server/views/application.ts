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
  applicationEditsFor,
  authorFor,
  readReuseFlags,
  readShortAnswers,
  type ApplicationEdit,
  type DraftAuthor,
  type DraftedRow,
} from "@/server/entities/jobs/applicationDrafts";
import {
  COVER_LETTER_ID,
  questionId,
} from "@/server/entities/jobs/applicationItemId";
import { loadMergedQuestions } from "@/server/entities/jobs/applicationQuestions";
import {
  partitionFindings,
  readApplicationReview,
} from "@/server/entities/jobs/applicationReview";
import { isCoverLetterQuestion, isStockFieldType } from "@/server/scrape/types";
import type {
  ApplicationDecision,
  DraftVerdict,
} from "@/server/subagents/registry/applicationDecider";
import type {
  NegotiationRow,
  NegotiationState,
} from "@/server/views/negotiationPanel";
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

export type ApplicationItem = NegotiationRow & {
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
  // Who wrote the text that's here, for the page's byline. Null when nothing is
  // written, or when nothing stamped it.
  author: DraftAuthor | null;
  status: ApplicationItemStatus;
  // What the pending change DID, in the same vocabulary the relay reports it to
  // Hank in — so the page's tag says "written" for text the user typed from
  // scratch rather than calling it an edit. Null when nothing is pending.
  change: ApplicationEdit["change"] | null;
  // Hank's one-line reason for leaving this alone, shown under an empty item.
  note: string | null;
  // What the decider ruled for this item. "skip" is the panel's cue to file it
  // under the fill-it-in-yourself tail instead of giving it an editor — a
  // person types their own LinkedIn URL faster than they read a draft of it.
  // Null when nothing has ruled on it: no draft pass has run AND the widget
  // type isn't a stock field.
  verdict: DraftVerdict | null;
  // This user described this question by hand, so they may reword it. A scraped
  // question is what the form actually says, and someone else's wording isn't
  // theirs to change — both render read-only.
  addedByYou: boolean;
  // What the review raised about THIS item, in the reviewer's own words,
  // sitting against the text it's about. `tone` is the whole of how it renders,
  // and it answers two questions at once — see FindingTone.
  findings: ApplicationFinding[];
};

// How one finding reads on the page. The split is not decoration: an objection
// to HANK's draft is a question he needs settled, and drawing it as a fault
// would be showing the user a warning about writing they didn't do. And a
// finding whose words have since changed doesn't disappear — it goes quiet and
// stays put until the relay carries it to him, so the user can see what their
// edit was answering instead of watching the reason for it vanish mid-edit.
export type FindingTone =
  // Open, on Hank's draft — quiet: he's asking about his own words.
  | "question"
  // Open, on the user's own words — the only one drawn as a fault.
  | "note"
  // The words it objected to are gone. Muted, and clears on the next message.
  | "answered";

export type ApplicationFinding = { note: string; tone: FindingTone };

export type ApplicationView = NegotiationState & {
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
};

// Everything still owed a conversation before this application is settled, and
// the two halves are different failures:
//
//   - a review finding nobody answered — the read-back objected to what's on the
//     page and the words it objected to are still there;
//   - a question the decider handed BACK ("ask_user") that still has nothing
//     written under it — Hank judged he couldn't answer it without the user, and
//     the user hasn't either.
//
// The second half is why this isn't just a finding count: an unanswered ask_user
// question never reaches the critic, because there is no draft to read back.
//
// A required question the decider never flagged does NOT count. This page exists
// for the writing that is hard — cover letters and short answers — and treating
// every blank stock field as an open thread would hold a submit on things the
// user fills in on the real form in seconds.
function openThreadCount(items: ApplicationItem[]): number {
  return items.reduce(
    (n, i) =>
      n +
      // Counted per finding, not per item: one answer can carry two separate
      // objections, and settling one doesn't settle the other. An answered one
      // is still drawn (muted, until the relay clears it) but is nobody's open
      // thread any more.
      i.findings.filter((f) => f.tone !== "answered").length +
      (i.verdict === "ask_user" && !(i.text ?? "").trim() ? 1 : 0),
    0,
  );
}

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
      relayedDrafts: true,
      applicationReview: true,
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

  const review = readApplicationReview(row.applicationReview);
  const partitioned = partitionFindings(review, (itemId) =>
    itemId === COVER_LETTER_ID
      ? row.coverLetter
      : (readShortAnswers(row.shortAnswers).find(
          (a) => questionId(a.question) === itemId,
        )?.answer ?? null),
  );
  const findingsFor = (
    itemId: string,
    author: DraftAuthor | null,
  ): ApplicationFinding[] => [
    ...partitioned.open
      .filter((f) => f.itemId === itemId)
      .map((f) => ({
        note: f.note,
        tone: author === "user" ? ("note" as const) : ("question" as const),
      })),
    ...partitioned.settled
      .filter((f) => f.itemId === itemId)
      .map((f) => ({ note: f.note, tone: "answered" as const })),
  ];
  // ONE source for "does this diverge from what Hank last wrote" — the same
  // function the relay reports the divergence to him with, so the page's tag and
  // the message he reads can never disagree about what changed, and both treat
  // editing back to his wording as a no-op. A hand-added question is folded in
  // below: it has no text to diverge, but the form asking something he can't
  // read is a change all the same.
  const changeByItem = new Map(
    applicationEditsFor(row).map((e) => [e.itemId, e.change]),
  );
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
        author: authorFor(row, { kind: "cover_letter" }),
        change: changeByItem.get(COVER_LETTER_ID) ?? null,
        addedByYou: false,
        findings: findingsFor(
          COVER_LETTER_ID,
          authorFor(row, { kind: "cover_letter" }),
        ),
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
        // `draftDecision` is null until a draft pass runs for this user, so
        // fall back to the same widget-type test `partitionApplicationForm`
        // applies before the decider ever sees the form — otherwise a form
        // nobody has drafted yet shows a dropdown and an essay identically.
        verdict: verdict?.verdict ?? (isStockFieldType(q.type) ? "skip" : null),
        note: verdict?.reason ?? null,
        author: authorFor(row, { kind: "question", question: q.question }),
        // A hand-added question is pending on its own account — there's no text
        // to diverge, and the news is that the form asks this at all.
        change:
          changeByItem.get(q.id) ??
          (q.addedByUserId === userId && !q.relayedAt ? "added" : null),
        addedByYou: q.addedByUserId === userId,
        findings: findingsFor(
          q.id,
          authorFor(row, { kind: "question", question: q.question }),
        ),
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
        author: authorFor(row, { kind: "question", question: a.question }),
        change: changeByItem.get(questionId(a.question)) ?? null,
        addedByYou: false,
        findings: findingsFor(
          questionId(a.question),
          authorFor(row, { kind: "question", question: a.question }),
        ),
      }),
    );
  }

  const job = row.job;
  const submitted = SUBMITTED_STATUSES.includes(row.status);
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
    submitted,
    // A submitted application is a record: the text stays editable because it's
    // reusable elsewhere, but there is no longer a negotiation to settle.
    open: !submitted,
    pendingCount: items.filter((i) => i.pending).length,
    openThreadCount: openThreadCount(items),
    formUnreadable:
      (merged.formUnavailable || merged.formNeverFetched) &&
      merged.userAddedQuestions.length === 0,
    formEmpty: items.length === 0 && !merged.formNeverFetched,
    wantsCoverLetter: merged.formWantsCoverLetter,
    items,
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
  author: DraftAuthor | null;
  change: ApplicationEdit["change"] | null;
  addedByYou: boolean;
  findings: ApplicationFinding[];
}): ApplicationItem {
  const hasText = (input.text ?? "").trim().length > 0;
  // Anything written that Hank didn't write reads as the user's — the same
  // default isUserOwned takes, so the page and the critic can't disagree about
  // whose sentences these are.
  const status: ApplicationItemStatus = hasText
    ? input.author === "hank"
      ? "drafted"
      : "written_by_you"
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
    author: hasText ? input.author : null,
    status,
    change: input.change,
    pending: input.change !== null,
    // A reason only earns space when there's nothing written to read instead.
    note: hasText ? null : input.note?.trim() || null,
    verdict: input.verdict,
    addedByYou: input.addedByYou,
    findings: input.findings,
  };
}
