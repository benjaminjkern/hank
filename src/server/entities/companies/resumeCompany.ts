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
// ("let's do mistral"). Bumps an idle company to READY — the walkthrough writes
// every status after that as it works, so this only has to make the row look
// like something being worked rather than something waiting.
//
// A company already mid-work keeps its status: overwriting SHORTLISTING with
// READY would throw away "the board is open and it's your turn" for a company
// the user just asked to look at.
//
// Refuses CLOSED (terminal — the user hard-skipped it) and BLOCKED (needs the
// revive path to re-hunt the board; a plain switch would leave it walkable with
// no readable source). The caller routes those to reviveCompany.
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
  // PAUSED is here rather than refused: switching to a paused company IS the
  // revive, and routing through companyStatusFields clears its pause reason.
  const idle =
    ci.status === CompanyStatus.NEW ||
    ci.status === CompanyStatus.PAUSED ||
    ci.status === CompanyStatus.CAUGHT_UP;
  if (idle) {
    await prisma.companyInteraction.update({
      where: {
        userId_companyId: { userId: args.userId, companyId: args.companyId },
      },
      data: companyStatusFields({ status: CompanyStatus.READY }),
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
      // Unconditional, unlike switchToCompany: a revive means "start this one
      // over", which is also why it clears the scrape stamp below.
      ...companyStatusFields({ status: CompanyStatus.READY }),
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
