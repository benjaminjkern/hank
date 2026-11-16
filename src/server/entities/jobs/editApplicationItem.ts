// The user's own write to one item on the application page — its text, its
// "ok to reuse when drafting" switch, or both. The sibling of
// `persistApplicationAnswer`, which is the write for words that arrive through
// chat (Hank's drafts, or the user dictating to him).
//
// Nothing here touches either baseline, and that IS the mechanism: text that no
// longer matches what Hank wrote is the user's, and text that doesn't match what
// he's seen is an unsent change. Writing a baseline would erase both facts.
// It does set the reuse flag on the touched item — working the text is what
// makes it worth drawing on later — and an explicit `reuse` in the same edit
// (the switch itself) wins.

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { normalizeForCompare } from "@/shared/utils/text";

import { readReuseFlags, readShortAnswers } from "./applicationDrafts";
import { COVER_LETTER_ID, questionId } from "./applicationItemId";
import { resolveQuestionId } from "./applicationQuestions";

export type ApplicationItemEdit = {
  // "cover_letter" or a questionId from the application view.
  itemId: string;
  // The full new text. Empty (or whitespace) clears the item.
  text?: string;
  // The reuse switch, when that's what was toggled.
  reuse?: boolean;
};

export type EditApplicationItemResult =
  // `not_found`: this user has no JobInteraction for the job. `unknown_item`:
  // the id names neither the cover letter, a question on the form, nor an
  // answer already saved.
  { ok: true } | { ok: false; reason: "not_found" | "unknown_item" };

export async function editApplicationItem(
  userId: string,
  jobId: string,
  edit: ApplicationItemEdit,
): Promise<EditApplicationItemResult> {
  const { itemId, text, reuse } = edit;

  const existing = await prisma.jobInteraction.findUnique({
    where: { userId_jobId: { userId, jobId } },
    select: {
      coverLetter: true,
      shortAnswers: true,
      shortAnswersReuse: true,
    },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  const data: Prisma.JobInteractionUpdateInput = {};

  if (itemId === COVER_LETTER_ID) {
    if (text !== undefined) {
      const next = text.trim().length > 0 ? text : null;
      data.coverLetter = next;
      // Clearing an item leaves reuse alone — there's nothing to reuse, and the
      // next edit re-sets it.
      if (next !== null && next !== existing.coverLetter) {
        data.coverLetterReuse = true;
      }
    }
    if (reuse !== undefined) data.coverLetterReuse = reuse;
  } else {
    // The id resolves through the merged form so a question the panel showed
    // maps to the exact text the answer is keyed by.
    const resolved = await resolveQuestionId(jobId, itemId);
    const answers = readShortAnswers(existing.shortAnswers);
    const flags = readReuseFlags(existing.shortAnswersReuse);
    while (flags.length < answers.length) flags.push(null);

    // An id that no longer resolves against the form can still match an answer
    // already saved under it — the form changed, the answer didn't.
    const question =
      resolved?.kind === "question"
        ? resolved.text
        : answers.find((a) => questionId(a.question) === itemId)?.question;
    if (!question) return { ok: false, reason: "unknown_item" };
    const norm = normalizeForCompare(question);
    const idx = answers.findIndex(
      (a) => normalizeForCompare(a.question) === norm,
    );

    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        if (idx >= 0) {
          answers.splice(idx, 1);
          flags.splice(idx, 1);
        }
      } else if (idx >= 0) {
        if (answers[idx].answer !== text) flags[idx] = true;
        answers[idx] = { question, answer: text };
      } else {
        answers.push({ question, answer: text });
        flags.push(true);
      }
      data.shortAnswers = answers;
      data.shortAnswersReuse = flags;
    }
    if (reuse !== undefined && idx >= 0) {
      flags[idx] = reuse;
      data.shortAnswersReuse = flags;
    }
  }

  // proposedDrafts is deliberately NOT touched here: the whole point is that
  // this write diverges from what Hank last wrote, which is what makes the edit
  // visible to the relay.
  await prisma.jobInteraction.update({
    where: { userId_jobId: { userId, jobId } },
    data,
    select: { id: true },
  });
  return { ok: true };
}
