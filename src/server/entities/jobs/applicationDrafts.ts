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
};

export const DRAFTED_ROW_SELECT = {
  coverLetter: true,
  coverLetterReuse: true,
  shortAnswers: true,
  shortAnswersReuse: true,
  proposedDrafts: true,
} as const;

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

// Whether the live text is the user's rather than Hank's — either it diverges
// from what he wrote, or they claimed it via the reuse switch. The critic and
// any redraft must leave these alone.
export function isUserOwned(
  row: DraftedRow,
  item: ApplicationItemRef,
): boolean {
  const drafts = readProposedDrafts(row.proposedDrafts);
  if (item.kind === "cover_letter") {
    if (row.coverLetterReuse === true) return true;
    const base = baselineFor(drafts, item);
    if (base === undefined) return (row.coverLetter ?? "").trim().length > 0;
    return !sameText(row.coverLetter, base);
  }
  const answers = readShortAnswers(row.shortAnswers);
  const reuse = readReuseFlags(row.shortAnswersReuse);
  const norm = normalizeForCompare(item.question);
  const idx = answers.findIndex(
    (a) => normalizeForCompare(a.question) === norm,
  );
  if (idx < 0) return false;
  if (reuse[idx] === true) return true;
  const base = baselineFor(drafts, item);
  if (base === undefined) return answers[idx].answer.trim().length > 0;
  return !sameText(answers[idx].answer, base);
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
};

// An APPLIED row is a record, not a working surface: the user may still tidy
// text they'll reuse elsewhere, and none of that is something Hank should be
// told to reconsider.
const RELAYABLE_STATUSES: JobInteractionStatus[] = [
  JobInteractionStatus.NEW,
  JobInteractionStatus.SCANNED,
  JobInteractionStatus.SHORTLISTED,
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
      coverLetter: true,
      coverLetterReuse: true,
      shortAnswers: true,
      shortAnswersReuse: true,
      proposedDrafts: true,
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
    return edits.length === 0
      ? []
      : [
          {
            jobId: r.job.id,
            jobTitle: r.job.title,
            companyName: r.job.company?.name ?? null,
            edits,
            addedQuestions: added.map((q) => q.question),
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
    select: { id: true, coverLetter: true, shortAnswers: true },
  });
  await bulkUpdate(
    "JobInteraction",
    "id",
    rows.map((row) => ({
      key: row.id,
      patch: { proposedDrafts: proposedDraftsPatch(row) as Prisma.JsonValue },
    })),
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
    return `${where}:\n${lines.join("\n")}`;
  });
  return [
    "(From the application page — the user changed this by hand since their last message.",
    "[-cut-] and {+added+} mark what moved; text between them is unchanged.)",
    "",
    ...blocks,
  ].join("\n");
}
