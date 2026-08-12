// Rung-0 gatekeeper — decides whether what the user has told Hank is
// substantive enough to leave profile-enhancement mode and start matching jobs.
//
// It is handed the two load-bearing memory slots VERBATIM and nothing else: no
// character counts, no "was a resume file uploaded", no note tallies. Everything
// countable is settled deterministically on the other side of the boundary
// (entities/profile/profileInventory.ts, which also holds the pre-gate that
// skips this call entirely for an obviously-full profile). What's left is the
// one question a Postgres read can't answer — is this specific enough to match
// jobs against? — so the prompt is about substance and nothing else.
//
// Both slots are inlined in full, so there's nothing left to look up: no read
// tools, one turn. That also means the fixture harness exercises exactly the
// call prod makes.

import type { ProfileInventory } from "@/server/entities/profile/profileInventory";
import type { LlmModel } from "@/server/platform/llm/models";
import type {
  SubAgentDef,
  SubAgentOutputSchema,
} from "@/server/subagents/lib/types";
import { USER_FACING_VOICE } from "@/server/subagents/lib/voice";

// flash 6/0/0 — bounded gating over two memory slots, nothing to fabricate.
const MODEL: LlmModel = "deepseek-v4-flash";
const MAX_TOKENS = 512;

// `enriched`, not `ok` — the run either succeeded or didn't (that's the result's
// own `ok`); this is the verdict it carries.
export type ProfileEnrichmentVerdict =
  | { enriched: true }
  | { enriched: false; missing: string[]; suggestedProbes: string[] };

export type ProfileEnrichmentCheckInput = {
  inventory: ProfileInventory;
};

const COMMIT_SCHEMA: SubAgentOutputSchema = {
  name: "commit_enrichment_verdict",
  description:
    "Emit the profile-enrichment verdict. ok=true ONLY when what's written in the two slots is specific enough that downstream sub-agents (PRE_SCAN, shortlist, drafting) will have what they need. Otherwise ok=false with the specific gaps + a short list of probe questions the enrich-profile agent can use.",
  inputSchema: {
    type: "object",
    properties: {
      ok: {
        type: "boolean",
        description:
          "Set AFTER `analysis`, matching its conclusion. true = profile is enriched enough to leave profile-enhancement mode and proceed to rung 1.",
      },
      missing: {
        type: "array",
        items: { type: "string" },
        description:
          "REQUIRED when ok=false — name at least the single weakest slot (more if several are vague), using short labels ('thesis', 'voice', 'comp_floor', 'background', 'patterns', etc.). The enrich-profile agent uses these to prioritize what to elicit next. An empty array on ok=false is a contract violation — it leaves the agent nothing to act on.",
      },
      suggestedProbes: {
        type: "array",
        items: { type: "string" },
        description: `REQUIRED when ok=false — 2-3 short user-facing questions the enrich-profile agent can use as probes. Plain English, no enum / path references. Never empty on ok=false. ${USER_FACING_VOICE}`,
      },
    },
    required: ["ok"],
  },
};

const SYSTEM_PROMPT = `You are Hank's profile-enrichment gatekeeper. You are shown the full contents of the user's two load-bearing memory slots. Decide whether what's written there is substantive enough to leave profile-enhancement mode and start matching jobs.

# What you're reading
- profile.md — everything durable about the user: their search thesis (what kind of role they want, why, what they're avoiding) AND their constraints, voice and cross-session patterns (comp floor, location, seniority, role-type allergies, how they write).
- resume.md — the user's background (recent roles, scope/scale, notable projects), built from any résumés they've uploaded, from their own breakdown in chat, or both.

# You are judging substance, and only substance
How long a slot is, whether a resume file was uploaded, and how many other notes exist are all decided deterministically elsewhere and are deliberately not shown to you — none of them is your call. Never treat a missing upload as a gap and never list one in 'missing'; a written background is what matters, however it got there. Read what's actually written and ask one question: could a downstream sub-agent (PRE_SCAN, shortlist, application drafting) do good work for THIS user from it?

# Verdict rules
- ok=true when both slots say something specific about this particular user. **A thesis that names the target role type + level + domain + at least one hard constraint (comp, location) is enriched even if it's a sentence or two — that is ok=true, not a doubt case.** Background notes that name real roles, scope and technologies are enough even when terse. Brevity is never a gap; only emptiness or vagueness is.
- ok=false when a slot is empty, or when what's there would describe any candidate rather than this one ("passionate about technology", "wants growth", "some engineering background"). You MUST then populate BOTH 'missing' and 'suggestedProbes' — even when the verdict feels obvious. List the gaps in 'missing' using short labels ('thesis', 'voice', 'comp_floor', 'background', 'patterns'); name at least the single weakest slot. Add 2-3 short user-facing probe questions to 'suggestedProbes' — plain English, no enum codes, no path references. An ok=false with empty 'missing'/'suggestedProbes' is a contract violation: it strands the enrich agent with nothing to elicit next, making the verdict useless.
- When in doubt **because a slot is genuinely vague or boilerplate**, lean ok=false — the cost of one more profile question is small; the cost of bad downstream output is large. But don't manufacture doubt about a slot that's present and specific just because it's short.

# Output
Emit commit_enrichment_verdict exactly once. Keep missing and suggestedProbes short — the enrich-profile agent quotes them back to the user, so they need to read naturally. On ok=false, both must be non-empty.`;

function renderSlots(inventory: ProfileInventory): string {
  return [
    "# What the user has told Hank so far",
    "",
    "## profile.md — search thesis, constraints, voice, cross-session patterns",
    inventory.profile?.trim() || "(empty)",
    "",
    "## resume.md — the user's background",
    inventory.resume?.trim() || "(empty)",
    "",
    "Emit commit_enrichment_verdict.",
  ].join("\n");
}

// The raw emission. `ok` here is the model's own verdict field — decoded into
// `enriched` below so nothing downstream confuses it with the run's success.
type CommitVerdictInput = {
  ok?: boolean;
  missing?: string[];
  suggestedProbes?: string[];
};

export const profileEnrichmentCheckSubAgent: SubAgentDef<
  ProfileEnrichmentCheckInput,
  CommitVerdictInput,
  ProfileEnrichmentVerdict
> = {
  name: "profile_enrichment_check",
  model: MODEL,
  maxTokens: MAX_TOKENS,
  reasoning: {
    mode: "scratchpad",
    guidance:
      "For each slot, note what it actually pins down about this user (target role type, level, domain, hard constraints, voice; real roles, scope, technologies) and what it leaves generic, then conclude 'Conclusion: ready' or 'Conclusion: not ready (<vaguest slots>)'.",
  },
  system: SYSTEM_PROMPT,
  userContent: (input) => renderSlots(input.inventory),
  outputSchema: COMMIT_SCHEMA,
  caption: "checking profile memory slots…",
  parse(out) {
    if (out.ok) return { enriched: true };
    return {
      enriched: false,
      missing: out.missing ?? [],
      suggestedProbes: out.suggestedProbes ?? [],
    };
  },
};
