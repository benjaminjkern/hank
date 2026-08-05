// Per-turn watchlist hint block: every company Hank could be asked to switch
// to, so a user saying "let's do Stripe" resolves to a slug he can pass to
// company_walkthrough.
//
// Lists every company — none is singled out as "current". Ordered stalest-first
// (never-discussed first) and capped, because
// the block is rebuilt into the system prompt on every turn.

import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

// The cap is the reason the ordering matters: past this many, the stalest
// companies are the ones worth reminding Hank about — the fresh ones are
// already in the conversation.
const WATCHLIST_LIMIT = 30;

export async function loadHankWatchlistContext(
  userId: string,
): Promise<string> {
  const rows = await prisma.companyInteraction.findMany({
    where: { userId, status: { not: CompanyStatus.CLOSED } },
    orderBy: { lastDiscussedAt: { sort: "asc", nulls: "first" } },
    take: WATCHLIST_LIMIT,
    select: {
      status: true,
      company: { select: { name: true, slug: true } },
    },
  });

  if (rows.length === 0) {
    return "\n# Your watchlist (for company_walkthrough)\n(empty — no other companies available to switch to. If the user names a specific company, call list_companies({name: '<name>'}) before claiming it's not on the watchlist; the user may have a PAUSED/CAUGHT_UP row this block doesn't show.)\n";
  }
  return (
    `\n# Your watchlist (for company_walkthrough)\nThese are the user's watchlisted companies, ordered by stalest activity first (cap: ${rows.length}). Use the listed slug verbatim when calling company_walkthrough (or just pass the company name — it looks it up). **This block is a hint, not the full list, and it omits CLOSED companies** — if the user names a company you don't see here, call list_companies({name: "<name>"}) (no status filter, so it includes skipped/closed rows) to check before claiming it's not on the watchlist. If that turns up a CLOSED row, the company IS on the list — offer to revive it by naming it in company_walkthrough, don't re-add it. The user often has more companies than fit here, especially PAUSED ones that have been quiet a while.\n` +
    rows
      .map((c) => `- ${c.company.name} (${c.company.slug}) — ${c.status}`)
      .join("\n") +
    "\n"
  );
}
