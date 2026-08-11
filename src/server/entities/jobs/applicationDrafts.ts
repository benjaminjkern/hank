// Who wrote which piece of an application, and the relay that carries a user's
// panel edits into their next message.
//
// `JobInteraction.proposedDrafts` holds the text as HANK last wrote it. The live
// `coverLetter` / `shortAnswers` hold what's actually there. Everything here
// falls out of comparing the two — the same proposal-vs-what's-drawn test
// `boardStance` runs on a shortlist row, so editing back to Hank's wording is a
// no-op rather than a change to report, and nothing needs a dirty flag.
//
// The baseline is re-stamped whenever Hank writes (his new text becomes the
// thing to diverge from) and whenever an edit is relayed (he's now seen it).

import { JobInteractionStatus, Prisma } from "@/generated/prisma/client";
import { bulkUpdate } from "@/server/db/bulkUpdate";
import { prisma } from "@/server/db/prisma";
import { diffWords, renderWordDiff, type WordDiff } from "@/utils/diff";
import { nowDate } from "@/utils/now";
import { normalizeForCompare } from "@/utils/text";

import { COVER_LETTER_ID, questionId } from "./applicationItemId";
import {
  drainSettledFindings,
  readApplicationReview,
  type ReviewFinding,
} from "./applicationReview";
import {
  markUserQuestionsRelayed,
  readStoredUserQuestions,
} from "./userAddedQuestions";

import type { ShortAnswer } from "./types";

export type ProposedDrafts = {
  coverLetter: string | null;
  answers: Array<{ question: string; text: string }>;
};

// One item on an application form, as every rule here addresses it.
export type ApplicationItemRef =
  { kind: "cover_letter" } | { kind: "question"; question: string };

// A row's application text plus the baseline it's compared against — the input
// every rule in this file takes.
export type DraftedRow = {
  coverLetter: string | null;
  coverLetterReuse: boolean | null;
  shortAnswers: Prisma.JsonValue | null;
  shortAnswersReuse: Prisma.JsonValue | null;
  proposedDrafts: Prisma.JsonValue | null;
  draftAuthors: Prisma.JsonValue | null;
};

export const DRAFTED_ROW_SELECT = {
  coverLetter: true,
  coverLetterReuse: true,
  shortAnswers: true,
  shortAnswersReuse: true,
  proposedDrafts: true,
  draftAuthors: true,
} as const;

// Who wrote the text an item holds right now. Stamped by the write that put it
// there, because it can't be derived: relaying an edit re-baselines
// proposedDrafts to the user's words, so one message later the divergence that
// proved they wrote it is gone.
export type DraftAuthor = "hank" | "user";

export type DraftAuthors = {
  coverLetter: DraftAuthor | null;
  answers: Array<{ question: string; author: DraftAuthor }>;
};

function asAuthor(v: unknown): DraftAuthor | null {
  return v === "hank" || v === "user" ? v : null;
}

export function readDraftAuthors(raw: Prisma.JsonValue | null): DraftAuthors {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { coverLetter: null, answers: [] };
  }
  const obj = raw as Record<string, unknown>;
  const answers = Array.isArray(obj.answers)
    ? obj.answers.flatMap((e) => {
        if (!e || typeof e !== "object" || Array.isArray(e)) return [];
        const rec = e as Record<string, unknown>;
        const author = asAuthor(rec.author);
        return typeof rec.question === "string" && author
          ? [{ question: rec.question, author }]
          : [];
      })
    : [];
  return { coverLetter: asAuthor(obj.coverLetter), answers };
}

// Null = nobody has claimed this item: nothing is written, or the text arrived
// by a path that doesn't stamp.
export function authorFor(
  row: Pick<DraftedRow, "draftAuthors">,
  item: ApplicationItemRef,
): DraftAuthor | null {
  const authors = readDraftAuthors(row.draftAuthors);
  if (item.kind === "cover_letter") return authors.coverLetter;
  const norm = normalizeForCompare(item.question);
  return (
    authors.answers.find((a) => normalizeForCompare(a.question) === norm)
      ?.author ?? null
  );
}

// Stamp one item's author, leaving the others alone. Returns the whole column
// value — every writer of application text calls this.
export function draftAuthorsPatch(
  row: Pick<DraftedRow, "draftAuthors">,
  item: ApplicationItemRef,
  author: DraftAuthor,
): Prisma.InputJsonValue {
  const authors = readDraftAuthors(row.draftAuthors);
  if (item.kind === "cover_letter") {
    return {
      ...authors,
      coverLetter: author,
    } as unknown as Prisma.InputJsonValue;
  }
  const norm = normalizeForCompare(item.question);
  const hit = authors.answers.some(
    (a) => normalizeForCompare(a.question) === norm,
  );
  const answers = hit
    ? authors.answers.map((a) =>
        normalizeForCompare(a.question) === norm
          ? { question: item.question, author }
          : a,
      )
    : [...authors.answers, { question: item.question, author }];
  return { ...authors, answers } as unknown as Prisma.InputJsonValue;
}

// Drop an item's stamp — the text it described is gone.
export function forgetDraftAuthor(
  row: Pick<DraftedRow, "draftAuthors">,
  item: ApplicationItemRef,
): Prisma.InputJsonValue {
  const authors = readDraftAuthors(row.draftAuthors);
  if (item.kind === "cover_letter") {
    return {
      ...authors,
      coverLetter: null,
    } as unknown as Prisma.InputJsonValue;
  }
  const norm = normalizeForCompare(item.question);
  return {
    ...authors,
    answers: authors.answers.filter(
      (a) => normalizeForCompare(a.question) !== norm,
    ),
  } as unknown as Prisma.InputJsonValue;
}

export function readShortAnswers(raw: Prisma.JsonValue | null): ShortAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return [];
    const rec = e as Record<string, unknown>;
    return typeof rec.question === "string" && typeof rec.answer === "string"
      ? [{ question: rec.question, answer: rec.answer }]
      : [];
  });
}

export function readReuseFlags(
  raw: Prisma.JsonValue | null,
): Array<boolean | null> {
  return Array.isArray(raw)
    ? raw.map((v) => (typeof v === "boolean" ? v : null))
    : [];
}

// null = no baseline was ever recorded, so every item reads as user-authored.
// Only reachable on a row nothing has drafted into yet.
export function readProposedDrafts(
  raw: Prisma.JsonValue | null,
): ProposedDrafts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const answers = Array.isArray(obj.answers)
    ? obj.answers.flatMap((e) => {
        if (!e || typeof e !== "object" || Array.isArray(e)) return [];
        const rec = e as Record<string, unknown>;
        return typeof rec.question === "string" && typeof rec.text === "string"
          ? [{ question: rec.question, text: rec.text }]
          : [];
      })
    : [];
  return {
    coverLetter: typeof obj.coverLetter === "string" ? obj.coverLetter : null,
    answers,
  };
}

// What Hank last wrote for one item. `undefined` means no baseline exists for it
// — a brand-new item nobody has drafted — which reads differently from `null`
// ("he's seen it empty"): the first is new text, the second is a fill-in.
function baselineFor(
  drafts: ProposedDrafts | null,
  item: ApplicationItemRef,
): string | null | undefined {
  if (!drafts) return undefined;
  if (item.kind === "cover_letter") return drafts.coverLetter;
  const norm = normalizeForCompare(item.question);
  const hit = drafts.answers.find(
    (a) => normalizeForCompare(a.question) === norm,
  );
  return hit ? hit.text : undefined;
}

function sameText(a: string | null, b: string | null): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

// Whether the live text is the user's rather than Hank's. The critic and any
// redraft must leave these alone — a critique of someone's own sentences is
// reported to them, not rewritten.
//
// Anything written that Hank didn't write counts, so text with no stamp is
// theirs by default: the conservative read, and the one that matches "he only
// rewrites what he can prove he wrote".
export function isUserOwned(
  row: DraftedRow,
  item: ApplicationItemRef,
): boolean {
  if (!hasText(row, item)) return false;
  return authorFor(row, item) !== "hank";
}

function hasText(row: DraftedRow, item: ApplicationItemRef): boolean {
  if (item.kind === "cover_letter") {
    return (row.coverLetter ?? "").trim().length > 0;
  }
  const norm = normalizeForCompare(item.question);
  return readShortAnswers(row.shortAnswers).some(
    (a) => normalizeForCompare(a.question) === norm && a.answer.trim() !== "",
  );
}

export type ApplicationEdit = {
  itemId: string;
  // "Cover letter", or the question as the form asks it.
  label: string;
  // "wrote" — nothing was there; "revised" — Hank's version changed;
  // "cleared" — the user emptied it; "added" — the user described a question
  // the scrape missed, which is news even with no answer under it yet.
  change: "wrote" | "revised" | "cleared" | "added";
  diff: WordDiff;
};

// Every item on one row whose live text differs from Hank's baseline.
export function applicationEditsFor(row: DraftedRow): ApplicationEdit[] {
  const drafts = readProposedDrafts(row.proposedDrafts);
  const out: ApplicationEdit[] = [];

  const push = (
    itemId: string,
    label: string,
    before: string | null,
    after: string | null,
  ) => {
    if (sameText(before, after)) return;
    const hadBefore = (before ?? "").trim().length > 0;
    const hasAfter = (after ?? "").trim().length > 0;
    out.push({
      itemId,
      label,
      change: !hadBefore ? "wrote" : !hasAfter ? "cleared" : "revised",
      diff: diffWords(before ?? "", after ?? ""),
    });
  };

  const coverBase = baselineFor(drafts, { kind: "cover_letter" });
  push(
    COVER_LETTER_ID,
    "Cover letter",
    coverBase === undefined ? null : coverBase,
    row.coverLetter,
  );

  for (const a of readShortAnswers(row.shortAnswers)) {
    const base = baselineFor(drafts, {
      kind: "question",
      question: a.question,
    });
    push(
      questionId(a.question),
      a.question,
      base === undefined ? null : base,
      a.answer,
    );
  }

  return out;
}

// The baseline patch that says "this is what Hank has seen" — the current text
// of every item. Written whenever he drafts and whenever an edit is relayed, so
// the next divergence is measured from the version he actually knows about.
export function proposedDraftsPatch(row: {
  coverLetter: string | null;
  shortAnswers: Prisma.JsonValue | null;
}): Prisma.InputJsonValue {
  const drafts: ProposedDrafts = {
    coverLetter: row.coverLetter,
    answers: readShortAnswers(row.shortAnswers).map((a) => ({
      question: a.question,
      text: a.answer,
    })),
  };
  return drafts;
}

export type ApplicationEditRelay = {
  jobId: string;
  jobTitle: string;
  companyName: string | null;
  edits: ApplicationEdit[];
  // The hand-added questions carried by this relay, by their exact text —
  // settle stamps these relayedAt so they report once, not every message.
  addedQuestions: string[];
  // Review findings this user answered by rewriting the item. The diff alone
  // shows WHAT changed; pairing it with the objection shows what question the
  // user was answering, which is the half worth remembering.
  settledFindings: ReviewFinding[];
};

// An APPLIED row is a record, not a working surface: the user may still tidy
// text they'll reuse elsewhere, and none of that is something Hank should be
// told to reconsider.
const RELAYABLE_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
  JobInteractionStatus.APPLYING,
  JobInteractionStatus.DEFERRED,
  JobInteractionStatus.PITCHED,
];

// Applications the user hand-edited but hasn't sent a message about yet.
// appendUserMessage snapshots these into a `panel_edits` block on the new user
// row, which is the ONLY relay — an edit persists immediately but never wakes
// Hank on its own.
export async function listUnrelayedApplicationEdits(
  userId: string,
): Promise<ApplicationEditRelay[]> {
  const rows = await prisma.jobInteraction.findMany({
    where: {
      userId,
      status: { in: RELAYABLE_STATUSES },
      OR: [
        { coverLetter: { not: null } },
        { shortAnswers: { not: Prisma.DbNull } },
        // A question described by hand is a change even with nothing written
        // under it — Hank has to hear the form asks something he couldn't read.
        { job: { userAddedQuestions: { not: Prisma.DbNull } } },
      ],
    },
    select: {
      ...DRAFTED_ROW_SELECT,
      applicationReview: true,
      job: {
        select: {
          id: true,
          title: true,
          userAddedQuestions: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  return rows.flatMap((r) => {
    // Only THIS user's unrelayed additions: the column is global to the job, so
    // another account's question isn't news to this user's Hank.
    const added = readStoredUserQuestions(r.job.userAddedQuestions).filter(
      (q) => q.addedByUserId === userId && !q.relayedAt,
    );
    const edits = [
      ...applicationEditsFor(r),
      ...added.map((q) => ({
        itemId: questionId(q.question),
        label: q.question,
        change: "added" as const,
        diff: EMPTY_DIFF,
      })),
    ];
    const settledFindings =
      readApplicationReview(r.applicationReview)?.settled ?? [];
    return edits.length === 0 && settledFindings.length === 0
      ? []
      : [
          {
            jobId: r.job.id,
            jobTitle: r.job.title,
            companyName: r.job.company?.name ?? null,
            edits,
            addedQuestions: added.map((q) => q.question),
            settledFindings,
          },
        ];
  });
}

// An added question has no before/after text, and the renderer skips the diff
// for that change kind — this is the shape the field still has to hold.
const EMPTY_DIFF: WordDiff = diffWords("", "");

// Re-baseline the rows just relayed: Hank has now seen this version, so the next
// divergence is measured from it. Every row's baseline is its own text, so the
// values differ per row — the case bulkUpdate exists for, in one statement.
export async function settleRelayedApplicationEdits(
  userId: string,
  relays: ApplicationEditRelay[],
): Promise<void> {
  if (relays.length === 0) return;
  const rows = await prisma.jobInteraction.findMany({
    where: { userId, jobId: { in: relays.map((r) => r.jobId) } },
    select: {
      id: true,
      coverLetter: true,
      shortAnswers: true,
      applicationReview: true,
    },
  });
  await bulkUpdate(
    "JobInteraction",
    "id",
    rows.map((row) => {
      // Settled findings ride this same relay, so they're spent once it lands.
      // Only the rows that actually have some carry the column — which costs a
      // second statement at most, since bulkUpdate groups by patch SHAPE, and
      // blanket-writing it would erase a review that simply had nothing to drain.
      const drained = drainSettledFindings(
        readApplicationReview(row.applicationReview),
      );
      return {
        key: row.id,
        patch: {
          proposedDrafts: proposedDraftsPatch(row) as Prisma.JsonValue,
          ...(drained
            ? { applicationReview: drained as unknown as Prisma.JsonValue }
            : {}),
        },
      };
    }),
  );
  // Added questions settle on their own marker rather than the draft baseline —
  // they live on the Job, and there's no text for a baseline to hold.
  await markUserQuestionsRelayed(
    userId,
    relays.map((r) => ({ jobId: r.jobId, questions: r.addedQuestions })),
    nowDate().toISOString(),
  );
}

// The model-facing prose for a relay — rendered once at write time and
// snapshotted into the block, so replay needs no renderer and can't drift.
export function renderApplicationEditRelayText(
  relays: ApplicationEditRelay[],
): string {
  const blocks = relays.map((r) => {
    const where = `${r.jobTitle}${r.companyName ? ` (${r.companyName})` : ""}`;
    const settled = r.settledFindings.map(
      (f) =>
        `- ${f.label} — rewritten after the read-back raised: "${f.note}" Their new wording is the answer to it.`,
    );
    const lines = r.edits.map((e) => {
      const verb =
        e.change === "wrote"
          ? "wrote this themselves"
          : e.change === "cleared"
            ? "deleted what was there"
            : e.change === "added"
              ? "added this question by hand — it wasn't on the form you could read"
              : "edited your draft";
      // An added question has no before/after to show, just the question.
      return e.change === "added"
        ? `- ${e.label} — ${verb}`
        : `- ${e.label} — ${verb}:\n    ${renderWordDiff(e.diff)}`;
    });
    return `${where}:\n${[...lines, ...settled].join("\n")}`;
  });
  return [
    "(From the application page — the user changed this by hand since their last message.",
    "[-cut-] and {+added+} mark what moved; text between them is unchanged.",
    "A line naming what the read-back raised is a question about the user that only they could settle — what they wrote back is the answer, and it holds for their other applications too.)",
    "",
    ...blocks,
  ].join("\n");
}
