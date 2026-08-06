// The stored shape of `Job.userAddedQuestions` — questions a person described
// by hand because the ATS form couldn't be scraped — and the two writes that
// rewrite entries in place.
//
// It's its own module because both halves of the application layer need it and
// they may not import each other: `applicationQuestions` merges these into the
// form it serves, while `applicationDrafts` reports the unrelayed ones as
// panel edits. The reader is deliberately raw (no `source` tag, no defaulting)
// — this is the on-disk shape, and rewriting an entry has to preserve fields
// this module doesn't know about.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { normalizeForCompare } from "@/utils/text";

export type StoredUserQuestion = {
  question: string;
  type?: string;
  required?: boolean;
  addedByUserId?: string;
  addedAt?: string;
  // When the adding user's chat last carried this question to Hank. Absent = he
  // hasn't been told, which is what the pending-change chip and the relay key
  // on.
  relayedAt?: string;
};

export function readStoredUserQuestions(raw: unknown): StoredUserQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    return typeof o.question === "string" && o.question.trim()
      ? [o as StoredUserQuestion]
      : [];
  });
}

export async function writeStoredUserQuestions(
  jobId: string,
  next: StoredUserQuestion[],
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { userAddedQuestions: next as unknown as Prisma.InputJsonValue },
  });
}

// Mark this user's hand-added questions as carried to Hank, so they report once
// rather than on every message. Scoped to the adder: the column is global to the
// job, and another account's question isn't news to this user.
export async function markUserQuestionsRelayed(
  userId: string,
  jobId: string,
  questions: string[],
  at: string,
): Promise<void> {
  if (questions.length === 0) return;
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { userAddedQuestions: true },
  });
  if (!job) return;
  const norms = new Set(questions.map((q) => normalizeForCompare(q)));
  const next = readStoredUserQuestions(job.userAddedQuestions).map((q) =>
    q.addedByUserId === userId && norms.has(normalizeForCompare(q.question))
      ? { ...q, relayedAt: at }
      : q,
  );
  await writeStoredUserQuestions(jobId, next);
}
