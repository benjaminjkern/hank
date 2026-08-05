// Per-turn profile context for the main Hank agent.
//
// buildHankSystem otherwise has NO user signal — the profile notes only reached
// Hank if it chose to call read_memory, which it usually didn't. So when Hank
// reasoned about whether a company/role fit, it was flying blind on the user's
// actual thesis + background and fell back on generic heuristics (down-ranking
// "platform/infra" roles, guessing location mismatches from the roles it
// happened to see). This loads the two load-bearing profile slots
// and renders them into the system prompt, with explicit guidance to judge fit
// against THEM, not generic priors. Pairs with the main-agent thinking (the
// model now has both the signal and the room to reason over it).

import { readMemory } from "@/server/memory/store";

// Generous per-slot cap — these are the core signal, so this should never
// truncate in practice; it only guards against a pathologically large note
// blowing up the (cached) system prompt. resume.md holds the user's whole
// background (every résumé they've uploaded, merged), so it runs long.
const PER_SLOT_CAP = 20000;

function clip(s: string): string {
  const t = s.trim();
  return t.length > PER_SLOT_CAP
    ? `${t.slice(0, PER_SLOT_CAP)}\n…(truncated)`
    : t;
}

// Build the `<your-profile>` block, or "" when the user has no profile content
// yet (brand-new user mid-onboarding — nothing to show; the profile flow builds
// it). Read failures degrade to "" rather than throwing the turn.
export async function loadHankProfileContext(userId: string): Promise<string> {
  let profile = "";
  let resume = "";
  try {
    [profile, resume] = (
      await Promise.all([
        readMemory(userId, "profile.md"),
        readMemory(userId, "resume.md"),
      ])
    ).map((s) => (s ?? "").trim());
  } catch {
    return "";
  }

  const parts: string[] = [];
  if (profile)
    parts.push(
      `## Profile (thesis, constraints, voice, patterns)\n${clip(profile)}`,
    );
  if (resume) parts.push(`## Background\n${clip(resume)}`);
  if (parts.length === 0) return "";

  return [
    "# What you know about the user",
    "This is the user's profile. Judge every fit decision against THIS — their actual thesis and background — not generic priors.",
    "",
    parts.join("\n\n"),
    "",
    "How to use it:",
    '- Match roles to the thesis + background above. Do NOT apply generic role-function preferences — never down-rank a role just for being "platform/infra" vs "product" (or the reverse) unless the thesis above actually says so. If the thesis is about a space/stage/mission (e.g. frontier AI, early-stage), weigh THAT, not the job\'s function label.',
    "- Never call a company a location mismatch from the roles you happen to have seen. A company with an office where the user can work could post a matching or remote role at any time. Treat location as a dealbreaker only with hard evidence the company doesn't hire where the user can be — otherwise it stays on the list, not closed.",
  ].join("\n");
}
