// The two ways a company becomes the thing you're working on again. Both are
// preconditions-plus-a-status-write and return a discriminated outcome rather
// than throwing — "you can't switch to a closed company" is a normal answer the
// caller has to phrase, not an exception.
//
// Neither touches the panel. Focus is ephemeral: the caller threads the company
// as the state machine's entry target and emits its own show events.

import { CompanyEventType, CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { companyStatusFields } from "./companyStatusFields";
import { logCompanyEvent } from "./logCompanyEvent";

export type ResumeCompanyResult =
  | { ok: true }
  // `reason` is a code, not a sentence — every caller words the refusal for its
  // own audience.
  | { ok: false; reason: "not_watchlisted" | "closed" | "unreadable_board" };

// Direct, in-walkthrough switch to a different company on the user's watchlist
// ("let's do mistral"). Bumps a non-terminal status to APPLYING so the picker
// wouldn't pull the user back to the prior company.
//
// Refuses CLOSED (terminal — the user hard-skipped it) and BLOCKED (needs the
// revive path to re-hunt the board; a plain switch would set APPLYING with no
// readable source). The caller routes those to reviveCompany.
export async function switchToCompany(args: {
  userId: string;
  companyId: string;
}): Promise<ResumeCompanyResult> {
  const ci = await prisma.companyInteraction.findUnique({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    select: { status: true },
  });
  if (!ci) return { ok: false, reason: "not_watchlisted" };
  if (ci.status === CompanyStatus.CLOSED)
    return { ok: false, reason: "closed" };
  if (ci.status === CompanyStatus.BLOCKED) {
    return { ok: false, reason: "unreadable_board" };
  }
  if (ci.status !== CompanyStatus.APPLYING) {
    await prisma.companyInteraction.update({
      where: {
        userId_companyId: { userId: args.userId, companyId: args.companyId },
      },
      data: companyStatusFields({ status: CompanyStatus.APPLYING }),
    });
  }
  return { ok: true };
}

// Bring a set-aside company back into play on an explicit user request
// ("actually, let's look at dbt Labs") — the override switchToCompany refuses.
// Idempotent: reviving a live company is just the status bump.
export async function reviveCompany(args: {
  userId: string;
  companyId: string;
}): Promise<ResumeCompanyResult> {
  const ci = await prisma.companyInteraction.findUnique({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    select: { status: true },
  });
  if (!ci) return { ok: false, reason: "not_watchlisted" };
  const wasTerminal =
    ci.status === CompanyStatus.CLOSED ||
    ci.status === CompanyStatus.BLOCKED ||
    ci.status === CompanyStatus.PAUSED;

  await prisma.companyInteraction.update({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    data: {
      ...companyStatusFields({ status: CompanyStatus.APPLYING }),
      // Force the walkthrough's on-entry scrape to fire (isScrapeStale(null) ===
      // true) so a revive looks for genuinely-new postings. Deliberately does
      // NOT mass-flip the company's CLOSED roles back to NEW: on a long-worked
      // company that's a backlog of thousands to re-prescan, and it discards
      // match judgments already paid for. Revive means "look again for what's
      // new"; the user can reopen a specific role on request.
      lastScrapedJobsAt: null,
    },
  });

  if (wasTerminal) {
    await logCompanyEvent({
      userId: args.userId,
      companyId: args.companyId,
      type: CompanyEventType.REVIVED,
      notes: "Revived — re-checking the board.",
    });
  }
  return { ok: true };
}
