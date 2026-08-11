import { z } from "zod";

import type { ToolDef } from "../lib/types";

// commit_discovery — settle the company list on the discovery panel: everything
// still checked goes onto the watchlist (URL hunt → scrape → prescan), and
// everything the user unchecked is recorded so the search stops proposing it.
// The whole batch settles, because every row arrives checked and there is no
// third state to leave behind.
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
    "Act on the company list on the user's screen: add every company still checked, record the ones they unchecked. **Every company you found starts CHECKED** — surfacing it is the proposal that it's worth tracking — so the user's job is to uncheck what they don't want and tell you to go. Call this the moment they do: any go-ahead ('add those', 'yeah go ahead', 'looks good', 'that's right') means call it, and so does a message that is only checkbox changes, since changing the list IS the ask. Do NOT call it when they're still reacting to the batch ('these are all too big', 'anything smaller?') — that's find_companies again with what they said as the direction. This settles the whole list, so don't call it while they're mid-thought. Takes no arguments: it reads what's on screen. Calling this ends your turn, so say anything you want to say BEFORE it.",
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
