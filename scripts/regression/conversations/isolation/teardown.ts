// Mandatory teardown. The DB is Railway PROD (see CLAUDE.md), so every row a
// persona run writes MUST be removed. This runs in a finally on every exit
// path (normal end, halt, spend-abort, uncaught throw).
//
// Scope: only USER-SCOPED rows are deleted. Global Company / Job / Event-under-
// other-users rows are SHARED catalog data — Hank deduplicates companies by
// slug and a Company with no remaining CompanyInteractions is invisible to other
// users (it's only reachable via a CompanyInteraction). Deleting a global
// company that a real user also watches would be data loss, so we never touch
// them. (Personas are instructed to use real company names to keep the catalog
// clean.) Job rows the run's scans created likewise stay — they're the
// company's real postings, shared across users.
//
// FK-safe order matters: AdminNote.sessionId and ChatMessage.sessionId are
// required (Restrict) → must delete before ChatSession. Event cascades from
// JobInteraction; OpportunityEvent/Contact cascade from Opportunity. Each
// delete is its own try/catch so one failing FK can't abort the rest, and
// every step is a deleteMany (no throw on zero rows) → idempotent.

import { prisma } from "@/server/db/prisma";

import { runEmailPrefix } from "../lib/tags";

export type ResidueCounts = Record<string, number>;

export type CapturedAdminNote = {
  category: string;
  severity: string;
  summary: string;
  context: string | null;
  dedupKey: string | null;
  occurrenceCount: number;
};

// Snapshot any AdminNote rows raised for this persona BEFORE teardown deletes
// them, so the persona report can surface them.
export async function captureAdminNotes(
  userId: string,
): Promise<CapturedAdminNote[]> {
  try {
    return await prisma.adminNote.findMany({
      where: { userId },
      select: {
        category: true,
        severity: true,
        summary: true,
        context: true,
        dedupKey: true,
        occurrenceCount: true,
      },
      orderBy: { createdAt: "asc" },
    });
  } catch {
    return [];
  }
}

async function step(
  label: string,
  fn: () => Promise<{ count: number }>,
  log: string[],
): Promise<void> {
  try {
    const { count } = await fn();
    if (count > 0) log.push(`  deleted ${count} ${label}`);
  } catch (err) {
    log.push(
      `  FAILED to delete ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Tear down one ephemeral user and everything it owns. Returns a human log of
// what was deleted. Safe to call twice (idempotent).
export async function teardownUser(userId: string): Promise<string[]> {
  const log: string[] = [];

  // (Focus is ephemeral now — no session focus / paused FKs to clear.)

  await step(
    "adminNote",
    () => prisma.adminNote.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "tokenUsage",
    () => prisma.tokenUsage.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "memoryNote",
    () => prisma.memoryNote.deleteMany({ where: { userId } }),
    log,
  );
  // JobInteraction delete cascades its Events.
  await step(
    "jobInteraction",
    () => prisma.jobInteraction.deleteMany({ where: { userId } }),
    log,
  );
  // Opportunity delete cascades OpportunityEvent + OpportunityContact.
  await step(
    "opportunity",
    () => prisma.opportunity.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "contact",
    () => prisma.contact.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "companyInteraction",
    () => prisma.companyInteraction.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "attachment",
    () => prisma.attachment.deleteMany({ where: { userId } }),
    log,
  );
  // ChatMessage has no userId — scope through its session.
  await step(
    "chatMessage",
    () => prisma.chatMessage.deleteMany({ where: { session: { userId } } }),
    log,
  );
  await step(
    "chatSession",
    () => prisma.chatSession.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "resume",
    () => prisma.resume.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "pushSubscription",
    () => prisma.pushSubscription.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "account",
    () => prisma.account.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "authSession",
    () => prisma.session.deleteMany({ where: { userId } }),
    log,
  );
  await step(
    "user",
    async () => {
      await prisma.user.delete({ where: { id: userId } });
      return { count: 1 };
    },
    log,
  );

  return log;
}

// Verify nothing remains for a user. Returns per-model residue counts; all
// zero means a clean teardown.
export async function residueForUser(userId: string): Promise<ResidueCounts> {
  const [
    adminNote,
    tokenUsage,
    memoryNote,
    jobInteraction,
    opportunity,
    contact,
    companyInteraction,
    attachment,
    chatMessage,
    chatSession,
    user,
  ] = await Promise.all([
    prisma.adminNote.count({ where: { userId } }),
    prisma.tokenUsage.count({ where: { userId } }),
    prisma.memoryNote.count({ where: { userId } }),
    prisma.jobInteraction.count({ where: { userId } }),
    prisma.opportunity.count({ where: { userId } }),
    prisma.contact.count({ where: { userId } }),
    prisma.companyInteraction.count({ where: { userId } }),
    prisma.attachment.count({ where: { userId } }),
    prisma.chatMessage.count({ where: { session: { userId } } }),
    prisma.chatSession.count({ where: { userId } }),
    prisma.user.count({ where: { id: userId } }),
  ]);
  return {
    adminNote,
    tokenUsage,
    memoryNote,
    jobInteraction,
    opportunity,
    contact,
    companyInteraction,
    attachment,
    chatMessage,
    chatSession,
    user,
  };
}

export type CompanyScanOutcome = {
  company: string;
  totalJobs: number;
  byStatus: Record<string, number>;
  closeReasons: Record<string, number>;
};

// Snapshot, per company the persona touched, how the prescan/scan triaged its
// jobs (status distribution + skip-reason distribution) BEFORE teardown — the
// raw data for judging whether the prescan is too aggressive (lots of CLOSED
// with off-thesis reasons vs genuinely few matches).
export async function captureScanOutcomes(
  userId: string,
): Promise<CompanyScanOutcome[]> {
  try {
    const jobInteractions = await prisma.jobInteraction.findMany({
      where: { userId },
      select: {
        status: true,
        closeReason: true,
        job: { select: { company: { select: { name: true } } } },
      },
    });
    const byCompany = new Map<string, CompanyScanOutcome>();
    for (const i of jobInteractions) {
      const name = i.job.company?.name ?? "(unaffiliated)";
      let o = byCompany.get(name);
      if (!o) {
        o = { company: name, totalJobs: 0, byStatus: {}, closeReasons: {} };
        byCompany.set(name, o);
      }
      o.totalJobs++;
      o.byStatus[i.status] = (o.byStatus[i.status] ?? 0) + 1;
      if (i.closeReason) {
        o.closeReasons[i.closeReason] =
          (o.closeReasons[i.closeReason] ?? 0) + 1;
      }
    }
    return [...byCompany.values()].sort((a, b) => b.totalJobs - a.totalJobs);
  } catch {
    return [];
  }
}

// Crash recovery: find every ephemeral user a run created (by email prefix)
// and tear each down. Used by `run.ts --cleanup --run <runId>`.
export async function cleanupRun(runId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: runEmailPrefix(runId) } },
    select: { id: true, email: true },
  });
  const log: string[] = [
    `cleanup run=${runId}: found ${users.length} ephemeral user(s)`,
  ];
  for (const u of users) {
    log.push(`user ${u.email}:`);
    log.push(...(await teardownUser(u.id)));
  }
  return log;
}
