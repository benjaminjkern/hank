import { z } from "zod";

import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { runCommitShortlist } from "@/server/procedures/registry/commitShortlist";
import { buildShowEvents } from "@/server/views/showEvents";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

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
    "Lock in the shortlist board at a company — call this ONLY when the user has agreed the board is right ('looks good', 'lock it in', 'go with that'). Every stance becomes real: picks become the shortlist, borderline roles are set aside (reversible), and passes are closed. The role picker comes up on its own afterwards — calling this ends your turn, so say anything you want to say BEFORE the call. Never commit while the user is still pushing back. `company` is the company's slug.",
  inputSchema: {
    type: "object",
    properties: {
      company: { type: "string", description: "The company's slug." },
    },
    required: ["company"],
  },
  parser: z.object({ company: z.string() }),
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
    return {
      content: `Committed the ${r.value.slug} shortlist: ${result.picked} shortlisted, ${result.setAside} set aside, ${result.closed} closed. The board is closed now — changing any of it from here is a normal record change (close_job / defer_job), not a board edit. The deterministic layer takes it from here.`,
      events: show.events,
      entryTarget: { kind: "company", id: r.value.id },
    };
  },
};
