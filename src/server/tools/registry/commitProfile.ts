import { z } from "zod";

import { runCommitProfile } from "@/server/procedures/registry/commitProfile";

import type { ToolDef } from "../lib/types";

export const commitProfileTool: ToolDef<Record<string, never>> = {
  name: "commit_profile",
  affectsViewedState: true,
  // A handoff only when the verdict passes: finishing setup is what brings up
  // the chooser. A failing verdict queues nothing, so Hank reads what's missing
  // and keeps eliciting.
  handoff: true,
  description:
    "Close out profile setup. Call this when you judge the profile complete enough for downstream sub-agents (PRE_SCAN / shortlist / drafting) to work well. The user should have just confirmed the synthesis in chat (\"let me make sure I got this correct…\"). It consolidates the conversation into memory, runs a verdict check, and either wraps up — your turn ends and the what's-next chooser comes up, so say anything you want to say BEFORE the call and don't also call show_whats_next — or comes back with a list of what's still missing so you can re-elicit.",
  parser: z.object({}).strict(),
  async handle(_input, ctx) {
    const r = await runCommitProfile(ctx);
    if (r.committed) {
      ctx.queue({ kind: "show_whats_next" });
      return { content: r.summary };
    }
    const missing = r.missing.length
      ? `still missing: ${r.missing.join(", ")}`
      : "still missing: (no specific gaps surfaced — re-check the profile and background notes)";
    const probes = r.suggestedProbes.length
      ? `\nsuggested probes:\n${r.suggestedProbes.map((p) => `- ${p}`).join("\n")}`
      : "";
    return {
      content: `${missing}${probes}\n\nFirst tell the user — in one natural sentence, framed as your own judgment about getting them good matches — that you're almost there and what you still need; then re-elicit it. Don't just fire another question, and don't mention any system, gate, or checkpoint. Don't call commit_profile again until the gap is filled.`,
    };
  },
};
