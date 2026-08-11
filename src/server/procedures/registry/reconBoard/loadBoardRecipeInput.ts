// Gathers what the board_recipe sub-agent reads. The seam is exactly where the
// I/O is: this function fetches the page and digests it, the def turns that
// digest into prompt text and nothing else (a def's userContent is pure and
// synchronous, which is what keeps a harness able to grade the prompt
// production actually sends).

import { buildPageEvidence } from "@/server/scrape/generic/pageEvidence";

import type { BoardRecipeInput } from "@/server/subagents/registry/boardRecipe";

export async function loadBoardRecipeInput(args: {
  companyName: string;
  sourceUrl: string;
  // What the deterministic probe already ruled out. Passed through rather than
  // re-derived: recon shouldn't re-propose a technique that just failed, and
  // re-running the probe to find out would double its cost.
  probeTried: string[];
}): Promise<BoardRecipeInput> {
  return {
    companyName: args.companyName,
    evidence: await buildPageEvidence(args.sourceUrl, args.probeTried),
  };
}
