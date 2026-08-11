// Run a candidate BoardRecipe against the live board and report what came back.
//
// Sub-agent-only — not in `hankToolsFor`. This is what makes recon safe, the
// same way `test_scrape` makes the URL hunter safe: the model doesn't get to
// ASSERT that a plan works, it has to watch the runner execute it and read the
// postings that came out. A recipe that survives this has been checked by
// validate.ts, not by the model's confidence.
//
// Nothing here writes. The recipe is persisted by the procedure that ran the
// sub-agent, after it returns.

import { z } from "zod";

import { runBoardRecipe } from "@/server/scrape/recipe/runRecipe";
import { withScrapeSignal } from "@/server/scrape/scrapeSignal";

import { toolError } from "../lib/toolError";

import type { BoardRecipe } from "@/server/scrape/recipe/types";
import type { ToolDef } from "../lib/types";

// Loose on purpose: the runner and validate.ts are the real gate, and a zod
// schema mirroring BoardRecipe would be a second copy of the format to keep in
// sync. A malformed recipe comes back as a structured error the model can fix,
// which is more useful than a parse rejection.
const parser = z.object({
  recipe: z.unknown(),
  boardUrl: z.string().optional(),
});

export const testRecipeTool: ToolDef<{ recipe: unknown; boardUrl?: string }> = {
  name: "test_recipe",
  description:
    "Run a candidate board recipe against the live board and report what it produced: job count, sample titles, sample URLs, whether the board came back partial, and any validation errors. Free (no LLM) and writes nothing. It SAMPLES — a small number of postings is a pass, not a truncated board. This is how you CHECK a recipe — never report one you haven't run through here. Expect to iterate: a wrong itemsPath returns 0 postings, a wrong title locator returns identical titles, a wrong URL locator returns duplicate or cross-domain URLs. Each error names what failed so you can fix that one field and re-run.",
  inputSchema: {
    type: "object",
    properties: {
      recipe: {
        type: "object",
        description:
          "The candidate BoardRecipe object, exactly as you would store it.",
      },
      boardUrl: {
        type: "string",
        description:
          "The board's own URL. Used to resolve relative links and to check that posting URLs stay on the board's domain. Defaults to the recipe's list URL.",
      },
    },
    required: ["recipe"],
  },
  parser,
  async handle({ recipe, boardUrl }, ctx) {
    const result = await withScrapeSignal(ctx.signal, () =>
      runBoardRecipe(recipe as BoardRecipe, {
        ...(boardUrl ? { boardUrl } : {}),
        // Samples rather than scraping the whole board: this answers "does the
        // plan locate postings", and the caller runs it in full once before
        // storing anything.
        sample: true,
      }),
    );
    ctx.signal?.throwIfAborted();

    if (!result.ok) {
      return toolError(
        "UPSTREAM_FETCH_FAILED",
        `test_recipe: ${result.error}`,
        "test_recipe:failed",
      );
    }

    const { jobs, diagnostics } = result.data;
    const samples = jobs
      .slice(0, 5)
      .map((j) => `- "${j.title}" → ${j.sourceUrl}`)
      .join("\n");
    const truncated =
      diagnostics?.truncatedAt != null
        ? ` The board is bigger than what came back (${diagnostics.truncatedAt} returned) — expected for a paged or capped board, and fine.`
        : "";
    const bodyLen = jobs[0]?.rawContent.length ?? 0;

    return {
      content: `test_recipe: ${jobs.length} posting${jobs.length === 1 ? "" : "s"} from ${result.data.companyName}.${truncated} First posting's body is ${bodyLen} chars.\n${samples}`,
    };
  },
};
