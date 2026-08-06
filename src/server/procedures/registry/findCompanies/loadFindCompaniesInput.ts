// Assembles what runFindCompanies searches from: the user's profile, résumé,
// their whole watchlist — both a dedup constraint and signal (companies they're
// pursuing pull suggestions toward that shape; ones they closed, with the
// reason, push away from it) — and what this search has proposed before,
// so a name the user already turned down doesn't come back unprompted.

import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { readResumeBackground } from "@/server/entities/resume/store";
import { listSuggestionHistory } from "@/server/entities/companies/companySuggestions";
import { readMemory } from "@/server/memory/store";
import type {
  FindCompaniesInput,
  WatchlistContextEntry,
} from "@/server/subagents/registry/findCompanies";

export async function loadFindCompaniesInput(args: {
  userId: string;
  direction?: string;
  count?: number;
}): Promise<FindCompaniesInput> {
  const [profile, resume, history, rows] = await Promise.all([
    readMemory(args.userId, "profile.md"),
    readResumeBackground(args.userId),
    listSuggestionHistory(args.userId),
    prisma.companyInteraction.findMany({
      where: { userId: args.userId },
      select: {
        status: true,
        closeReason: true,
        closeNote: true,
        pauseReason: true,
        pauseNote: true,
        blockReason: true,
        blockNote: true,
        company: { select: { name: true } },
      },
    }),
  ]);

  const watchlist: WatchlistContextEntry[] = rows
    .filter((row) => row.company.name)
    .map((row) => ({
      name: row.company.name,
      status: row.status,
      reason: setAsideReason(row),
    }));

  return {
    profile,
    resume,
    watchlist,
    history,
    ...(args.direction ? { direction: args.direction } : {}),
    ...(args.count != null ? { count: args.count } : {}),
  };
}

// Compose the one-line "why set aside" from the structured reason + optional
// note on a CLOSED / PAUSED / BLOCKED row. Returns undefined for active rows.
function setAsideReason(row: {
  status: CompanyStatus;
  closeReason: unknown;
  closeNote: string | null;
  pauseReason: unknown;
  pauseNote: string | null;
  blockReason: unknown;
  blockNote: string | null;
}): string | undefined {
  const humanize = (enumVal: unknown): string =>
    typeof enumVal === "string" ? enumVal.toLowerCase().replace(/_/g, " ") : "";
  if (row.status === CompanyStatus.CLOSED) {
    const why = humanize(row.closeReason);
    const note = row.closeNote?.trim();
    return `passed on${why ? ` (${why})` : ""}${note ? `: ${note}` : ""}`;
  }
  if (row.status === CompanyStatus.PAUSED) {
    const why = humanize(row.pauseReason);
    const note = row.pauseNote?.trim();
    return `on hold${why ? ` (${why})` : ""}${note ? `: ${note}` : ""}`;
  }
  if (row.status === CompanyStatus.BLOCKED) {
    const note = row.blockNote?.trim();
    // Technical set-aside ("couldn't read the board") — NOT a fit signal, so
    // don't let it steer suggestions the way a close reason does.
    return `couldn't read their board${note ? `: ${note}` : ""} (technical, not a fit judgment)`;
  }
  return undefined;
}
