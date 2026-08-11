import { z } from "zod";

import type { ToolDef } from "../lib/types";

// commit_discovery — settle the company list the user has been marking on the
// discovery panel: ADDs go onto the watchlist (URL hunt → scrape → prescan),
// PASSes are recorded so the search stops proposing them, and unmarked rows are
// left alone (they stay on the table and ride into the next search).
//
// The board's `commit_shortlist` in every respect that matters: a handoff that
// also WRITES, because settling the list IS entering the continuation — the
// deterministic arm narrates the ✓ lines and surfaces the add-more card, and
// ending Hank's turn is what denies him a free turn to narrate a panel that
// isn't his to draw.
export const commitDiscoveryTool: ToolDef<Record<string, never>> = {
  name: "commit_discovery",
  handoff: true,
  description:
    "Act on the company list on the user's screen: add everything they marked to add, record everything they marked pass. Call this when their marks (which arrive at the head of their message) are what they want acted on — that IS the ask, so a message that's only marks means call it. Also call it when they say it in words ('add those', 'yeah go ahead', 'those two look right'). Unmarked rows are untouched and stay on the list, so this never forces a verdict on anything. Do NOT call it when they're still reacting to the list ('these are all too big', 'anything smaller?') — that's find_companies again with what they said as the direction. Takes no arguments: it reads the marks. Calling this ends your turn, so say anything you want to say BEFORE it.",
  inputSchema: { type: "object", properties: {} },
  parser: z.object({}),
  handle() {
    return Promise.resolve({
      content:
        "Handed off to the company-list commit. It adds the marked companies, records the passes, and puts the refreshed list back on screen. Nothing more to do this turn — don't list any companies in chat.",
      entryTarget: { kind: "discovery_commit" as const },
    });
  },
};
