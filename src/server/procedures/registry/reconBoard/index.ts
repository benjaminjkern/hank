// Work out how to read a board nothing recognizes, and remember the answer.
//
// Entered on a MISS, never speculatively: the URL hunter gave up, or a scrape
// found no reader / found its stored plan broken. It costs an LLM call, so
// every entry point is gated and every outcome — including failure — is
// persisted, because the expensive case is the board that can never be read and
// would otherwise be re-attempted on every 24h staleness tick forever.
//
// It lives in procedures/ rather than beside the scrape layer for a reason that
// isn't bureaucratic: scrape/ is imported by entities/, entities/ may not call
// an LLM, so scrape/ may not either. That constraint is also the right design —
// recon is a once-per-board act, and putting it on the recurring scrape path
// would re-pay for it forever.

import { BoardReaderOrigin } from "@/generated/prisma/client";
import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { reconOnCooldown } from "@/server/entities/boardReaders/readerHealth";
import { saveBoardReader } from "@/server/entities/boardReaders/recordReaderRun";
import { withTraceSpan } from "@/server/platform/trace/span";
import { boardMatchKey } from "@/server/scrape/recipe/matchKey";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import { boardRecipeSubAgent } from "@/server/subagents/registry/boardRecipe";
import { nowDate } from "@/utils/now";

import { loadBoardRecipeInput } from "./loadBoardRecipeInput";

export type ReconBoardArgs = RunContext & {
  companyId: string;
  companyName: string;
  sourceUrl: string;
  // What the deterministic probe already tried, forwarded so recon doesn't
  // re-propose a technique that just failed.
  probeTried?: string[];
  // Skip the cooldown. The operator backfill script and an explicit re-enrich
  // set this; the automatic paths never do.
  force?: boolean;
};

export type ReconBoardResult =
  // A verified plan is on file and the board is now readable — the caller
  // should re-run its scrape.
  | { kind: "learned"; jobCount: number; note: string }
  | { kind: "needs_browser"; note: string }
  | { kind: "needs_auth"; note: string }
  | { kind: "exhausted"; note: string }
  // Didn't run. Not a verdict about the board.
  | { kind: "skipped"; why: "cooldown" | "no_match_key" | "failed" };

export async function runReconBoard(
  args: ReconBoardArgs,
): Promise<ReconBoardResult> {
  const matchKey = boardMatchKey(args.sourceUrl);
  if (!matchKey) return { kind: "skipped", why: "no_match_key" };

  // The cooldown is keyed on the BOARD, so a second company on the same board
  // inherits the verdict instead of re-buying it.
  if (!args.force) {
    const existing = await prisma.boardReader.findUnique({
      where: { matchKey },
      select: { reconnedAt: true },
    });
    if (reconOnCooldown(existing?.reconnedAt ?? null, nowDate())) {
      return { kind: "skipped", why: "cooldown" };
    }
  }

  const input = await loadBoardRecipeInput({
    companyName: args.companyName,
    sourceUrl: args.sourceUrl,
    probeTried: args.probeTried ?? [],
  });

  const run = await withTraceSpan("recon_board", args.trace, () =>
    runSubAgent(boardRecipeSubAgent, input, args),
  );
  if (!run.ok) {
    // A crashed recon is NOT a verdict about the board — persisting one would
    // start a 14-day cooldown off a transient failure. Leave no row.
    return { kind: "skipped", why: "failed" };
  }

  const outcome = run.output;
  if (outcome.outcome === "recipe") {
    await saveBoardReader({
      companyId: args.companyId,
      sourceUrl: args.sourceUrl,
      recipe: outcome.recipe,
      origin: BoardReaderOrigin.RECON,
      reconNote: outcome.note,
    });
    return { kind: "learned", jobCount: outcome.jobCount, note: outcome.note };
  }

  // A verdict, not a crash: write the row with no recipe. That row IS the
  // record — it starts the cooldown, it carries the reason a human will read on
  // /admin/board-readers, and its company count is what says whether this board
  // software is worth a hand-written provider.
  await saveBoardReader({
    companyId: args.companyId,
    sourceUrl: args.sourceUrl,
    recipe: null,
    origin: BoardReaderOrigin.RECON,
    needsBrowser: outcome.outcome === "needs_browser",
    reconNote: outcome.note,
  });
  return { kind: outcome.outcome, note: outcome.note };
}
