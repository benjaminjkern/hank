import { z } from "zod";

import { runCommitProfile } from "@/server/procedures/registry/commitProfile";

import type { ToolDef } from "../lib/types";

export const commitProfileTool: ToolDef<Record<string, never>> = {
  name: "commit_profile",
  affectsViewedState: true,
  // Deliberately NOT handoff. Whether profile setup is over depends on the
  // verdict, and `handoff` is a static flag — it can't branch on the outcome. So
  // the runner derives it instead: it re-checks the intake signal after the turn,
  // and a true→false flip (which only a passing commit_profile can cause) is the
  // completion that fires the what's-next chooser. On a failing verdict the
  // signal stays true, Hank keeps eliciting, and nothing advances.
  description:
    "Close out profile setup. Call this when you judge the profile complete enough for downstream sub-agents (PRE_SCAN / shortlist / drafting) to work well. The user should have just confirmed the synthesis in chat (\"let me make sure I got this correct…\"). It consolidates the conversation into memory, runs a verdict check, and either wraps up (you're done — the what's-next chooser comes up on its own, so don't also call show_whats_next) or comes back with a list of what's still missing so you can re-elicit on the next turn.",
  inputSchema: { type: "object", properties: {} },
  parser: z.object({}).strict(),
  async handle(_input, ctx) {
    const r = await runCommitProfile(ctx);
    if (r.wrappedUp) {
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
