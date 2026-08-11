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

import { boardIdentifiesCompany } from "./boardIdentity";
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
  // A few of the postings the recipe produced. Used only to check the board is
  // this company's — see boardIdentity.ts. Omit for a verdict row (no recipe).
  sampleJobUrls?: string[];
  // Set when the board only yields postings to a rendered browser, which prod
  // can't do. The row is the record of that, so a human can author a recipe
  // locally with scripts/ats/research-board.ts.
  needsBrowser?: boolean;
  reconNote?: string;
}): Promise<string | null> {
  const matchKey = boardMatchKey(args.sourceUrl);
  if (!matchKey) return null;

  // The one gate a learned reader cannot be persisted around. Enforced HERE
  // rather than at each call site because there are three of them (the probe
  // path, recon, and the operator backfill) and a reader that reads someone
  // else's board is not a thing any of them may store.
  if (args.recipe) {
    const company = await prisma.company.findUnique({
      where: { id: args.companyId },
      select: { name: true },
    });
    const identity = boardIdentifiesCompany({
      companyName: company?.name ?? "",
      boardUrl: args.sourceUrl,
      ...(args.sampleJobUrls ? { sampleJobUrls: args.sampleJobUrls } : {}),
    });
    if (!identity.ok) {
      // Store the REFUSAL, not the recipe: it starts the cooldown so this isn't
      // re-derived every pass, and the reason shows up on /admin/board-readers
      // where a human can overrule it.
      return await writeReader({
        matchKey,
        familyKey: null,
        sourceUrl: args.sourceUrl,
        recipe: null,
        origin: args.origin,
        needsBrowser: false,
        reconNote: `rejected: ${identity.reason}`,
        companyId: args.companyId,
        stampRecon: true,
      });
    }
  }

  return await writeReader({
    matchKey,
    familyKey: args.recipe?.familyKey ?? null,
    sourceUrl: args.sourceUrl,
    recipe: args.recipe,
    origin: args.origin,
    needsBrowser: args.needsBrowser ?? false,
    reconNote: args.reconNote ?? null,
    companyId: args.companyId,
    // A recon attempt is stamped whether or not it produced a plan — the
    // cooldown has to remember the failures, which are exactly the expensive
    // case.
    stampRecon: args.origin === BoardReaderOrigin.RECON,
  });
}

// The one upsert. Both the success path and the identity refusal above land
// here, so a refusal is stored exactly as deliberately as a working plan.
async function writeReader(args: {
  matchKey: string;
  familyKey: string | null;
  sourceUrl: string;
  recipe: BoardRecipe | null;
  origin: BoardReaderOrigin;
  needsBrowser: boolean;
  reconNote: string | null;
  companyId: string;
  stampRecon: boolean;
}): Promise<string> {
  const recipeJson = (args.recipe ?? Prisma.DbNull) as Prisma.InputJsonValue;
  const reconnedAt = args.stampRecon ? nowDate() : undefined;
  const shared = {
    familyKey: args.familyKey,
    sourceUrl: args.sourceUrl,
    recipe: recipeJson,
    origin: args.origin,
    needsBrowser: args.needsBrowser,
    reconNote: args.reconNote,
    ...(reconnedAt ? { reconnedAt } : {}),
  };

  const reader = await prisma.boardReader.upsert({
    where: { matchKey: args.matchKey },
    create: { matchKey: args.matchKey, ...shared },
    update: {
      ...shared,
      // A fresh plan clears the record of the old one's failures — that's what
      // re-authoring means.
      health: "HEALTHY",
      consecutiveFailures: 0,
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
