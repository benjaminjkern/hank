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
import { bulkUpdate } from "@/server/db/bulkUpdate";
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
//
// Takes the whole relay rather than one job: a relay settles every open
// application at once, and per-job it was a read and a write each. One read,
// one write, flat in the number of jobs.
export async function markUserQuestionsRelayed(
  userId: string,
  relayed: ReadonlyArray<{ jobId: string; questions: string[] }>,
  at: string,
): Promise<void> {
  const carrying = relayed.filter((r) => r.questions.length > 0);
  if (carrying.length === 0) return;

  const jobs = await prisma.job.findMany({
    where: { id: { in: carrying.map((r) => r.jobId) } },
    select: { id: true, userAddedQuestions: true },
  });
  const storedByJob = new Map(jobs.map((j) => [j.id, j.userAddedQuestions]));

  // Rows whose stored questions nothing matched are dropped rather than
  // rewritten to themselves, so the statement carries only real changes.
  const patches = carrying.flatMap((r) => {
    const raw = storedByJob.get(r.jobId);
    if (raw === undefined) return []; // job deleted between relay and settle
    const norms = new Set(r.questions.map((q) => normalizeForCompare(q)));
    let changed = false;
    const next = readStoredUserQuestions(raw).map((q) => {
      const mine =
        q.addedByUserId === userId &&
        norms.has(normalizeForCompare(q.question));
      if (!mine) return q;
      changed = true;
      return { ...q, relayedAt: at };
    });
    return changed
      ? [
          {
            key: r.jobId,
            patch: {
              userAddedQuestions: next as unknown as Prisma.JsonValue,
            },
          },
        ]
      : [];
  });

  await bulkUpdate("Job", "id", patches);
}
