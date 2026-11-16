import { z } from "zod";

import { sayUiEvents } from "@/server/contracts";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { buildShowEvents } from "@/server/panels/showEvents";
import { toolError } from "@/server/platform/agent/toolError";
import { runCommitShortlist } from "@/server/procedures/registry/commitShortlist";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// commit_shortlist — end the shortlist negotiation at one company: every stance
// on the board becomes real (picks → shortlisted, borderline → set aside
// reversibly, pass → closed), the board closes, and anywhere the user overruled
// the proposal is folded into memory (procedures/registry/commitShortlist.ts). Handoff on purpose: the commit is the entry into
// the walkthrough's continuation — the deterministic layer surfaces the role
// picker next, and ending Hank's turn is what denies a free post-commit turn to
// narrate a picker that isn't his to draw. One company per commit; another
// company's open board just stays open.
export const commitShortlistTool: ToolDef<{ company: string }> = {
  name: "commit_shortlist",
  handoff: true,
  description:
    "Lock in the shortlist board at a company — call this ONLY when the user has agreed the board is right ('looks good', 'lock it in', 'go with that'). Every stance becomes real: picks become the shortlist, borderline roles are set aside (reversible), and passes are closed. The role picker comes up on its own afterwards — calling this ends your turn, so say anything you want to say BEFORE the call. IMPORTANT: when NOTHING on the board is a pick and nothing is held, committing settles the whole company — the passes close and the company reads as caught up until something new is posted. Tell the user that plainly BEFORE you commit an all-pass board; never let 'lock it in' silently mean 'we're done here'. Never commit while the user is still pushing back. A pass on a role the user had already started applying to sets it aside instead of closing it; if they really want it closed, close_job it. `company` is the company's slug.",
  parser: z.object({
    company: z.string().describe("The company's slug."),
  }),
  async handle(input, ctx) {
    const r = await resolveCompanyBySlug(ctx.userId, input.company);
    if (!r.ok) return slugLookupError(r);
    const result = await runCommitShortlist({
      ...ctx,
      companyId: r.value.id,
      companyName: r.value.slug,
    });
    if (!result.ok) {
      return toolError(
        "GATE_BLOCKED",
        `no open shortlist negotiation at ${r.value.slug} — nothing to commit. A board opens when a company's read roles are ranked (company_walkthrough gets there).`,
        "commit_shortlist:no_open_board",
      );
    }
    // The board closes with the commit — leaving it on screen would offer a
    // surface with nothing left to decide. Back to the company page.
    const show = await buildShowEvents(ctx.userId, { companyId: r.value.id });
    await sayUiEvents(ctx.say, show.events);
    // A continuation: the commit's tail surfaces what the round produced — it
    // must not start new work at the company (no re-scrape).
    ctx.queue({
      kind: "company_walkthrough",
      companyId: r.value.id,
      continuation: true,
    });
    const keptStarted =
      result.keptStarted.length > 0
        ? ` The board passed on ${result.keptStarted.map((t) => `"${t}"`).join(", ")}, but the user had started applying, so ${result.keptStarted.length === 1 ? "it was" : "they were"} set aside instead of closed (the user was told). close_job only if they ask.`
        : "";
    return {
      content: `Committed the ${r.value.slug} shortlist: ${result.picked} shortlisted, ${result.setAside} set aside, ${result.closed} closed.${keptStarted} The board is closed now — changing any of it from here is a normal record change (close_job / defer_job), not a board edit. The walkthrough takes it from here.`,
    };
  },
};
