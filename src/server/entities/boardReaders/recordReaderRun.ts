// The two writes a learned board reader needs: save a newly-learned plan, and
// record how its last run went.
//
// Both are single statements. Nothing here calls an LLM or yields — a reader is
// a fact about a board, and the thing that AUTHORS one (procedures/registry/
// reconBoard/) is the procedure.

import { BoardReaderOrigin, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { boardMatchKey } from "@/server/scrape/recipe/matchKey";
import { nowDate } from "@/utils/now";

import { nextHealth, type ReaderRunOutcome } from "./readerHealth";

import type { BoardRecipe } from "@/server/scrape/recipe/types";

export type LoadedBoardReader = {
  id: string;
  recipe: BoardRecipe | null;
  quarantined: boolean;
  needsBrowser: boolean;
  reconnedAt: Date | null;
  origin: BoardReaderOrigin;
};

// Save a plan against its board and point the company at it. Upserts on
// matchKey, so the second company on the same board software reuses the row
// rather than minting a parallel one — which is what makes the cost of learning
// a board a one-time cost per BOARD rather than per company.
export async function saveBoardReader(args: {
  companyId: string;
  sourceUrl: string;
  recipe: BoardRecipe | null;
  origin: BoardReaderOrigin;
  // Set when the board only yields postings to a rendered browser, which prod
  // can't do. The row is the record of that, so a human can author a recipe
  // locally with scripts/ats/research-board.ts.
  needsBrowser?: boolean;
  reconNote?: string;
}): Promise<string | null> {
  const matchKey = boardMatchKey(args.sourceUrl);
  if (!matchKey) return null;

  const recipeJson = (args.recipe ?? Prisma.DbNull) as Prisma.InputJsonValue;
  const familyKey = args.recipe?.familyKey ?? null;
  // A recon attempt is stamped whether or not it produced a plan — the cooldown
  // has to remember the failures, which are exactly the expensive case.
  const reconnedAt =
    args.origin === BoardReaderOrigin.RECON ? nowDate() : undefined;

  const reader = await prisma.boardReader.upsert({
    where: { matchKey },
    create: {
      matchKey,
      familyKey,
      sourceUrl: args.sourceUrl,
      recipe: recipeJson,
      origin: args.origin,
      needsBrowser: args.needsBrowser ?? false,
      reconNote: args.reconNote ?? null,
      ...(reconnedAt ? { reconnedAt } : {}),
    },
    update: {
      familyKey,
      sourceUrl: args.sourceUrl,
      recipe: recipeJson,
      origin: args.origin,
      // A fresh plan clears the record of the old one's failures — that's what
      // re-authoring means.
      health: "HEALTHY",
      consecutiveFailures: 0,
      needsBrowser: args.needsBrowser ?? false,
      reconNote: args.reconNote ?? null,
      ...(reconnedAt ? { reconnedAt } : {}),
    },
    select: { id: true },
  });

  await prisma.company.update({
    where: { id: args.companyId },
    data: { boardReaderId: reader.id },
  });
  return reader.id;
}

// Fold one run's outcome into the reader's health. Read-modify-write rather
// than an atomic increment because `nextHealth` needs the prior streak, and a
// board is scraped at most once per user per 24h — the race is theoretical and
// its cost is one miscounted failure.
export async function recordReaderRun(
  readerId: string,
  outcome: ReaderRunOutcome,
): Promise<void> {
  const current = await prisma.boardReader.findUnique({
    where: { id: readerId },
    select: { health: true, consecutiveFailures: true },
  });
  if (!current) return;

  const next = nextHealth(current, outcome);
  const ranAt = nowDate();
  await prisma.boardReader.update({
    where: { id: readerId },
    data: {
      ...next,
      lastRunAt: ranAt,
      ...(outcome.ok
        ? {
            lastSucceededAt: ranAt,
            jobsLastRun: outcome.jobs,
            missingLastRun: outcome.missing ?? null,
            overlapLastRun: outcome.overlap ?? null,
          }
        : {}),
    },
  });
}
