// The read model behind the profile-enrichment gate: what has the user actually
// told Hank?
//
// The split of labor across this boundary is the point. Everything COUNTABLE
// about the profile — how long a slot is, whether a resume file was uploaded,
// how many company/job notes exist — is decided here, in Postgres, for free. The
// LLM verdict on the other side is handed slot CONTENTS and nothing else, so it
// only ever rules on substance ("is this thesis specific enough to match jobs
// against?"), which is the one question a length check can't answer.
//
// Three exports: the read, the rule, and the two composed. They are separate
// because the gate asks at two very different cadences — the chat runner runs
// the composed predicate EVERY turn to pick Hank's prompt body, while the
// enrichment gate already holds the slots it loaded for the sub-agent and only
// needs the rule applied to them.

import { readMemory } from "@/server/memory/store";

// Length floor for the deterministic pre-gate. Mirrors the threshold the
// pre-overhaul runWhatsNext used in its memory-gap heuristic: "obviously not a
// cold start"; below it we let the LLM decide whether shallow ≠ broken.
// profile.md carries double, because it absorbed two separately-floored profile
// slots — one 80-char floor on the merged note would have halved the bar a user
// has to clear to skip the profile flow.
const SHALLOW_THRESHOLD = 80;
const PROFILE_SHALLOW_THRESHOLD = SHALLOW_THRESHOLD * 2;

// What the enrichment judge reads: the two load-bearing slots, verbatim. No
// lengths, no counts, no was-a-file-uploaded flag — see the header.
export type ProfileInventory = {
  profile: string | null;
  resume: string | null;
};

export async function readProfileSlots(
  userId: string,
): Promise<ProfileInventory> {
  const [profile, resume] = await Promise.all([
    readMemory(userId, "profile.md"),
    readMemory(userId, "resume.md"),
  ]);
  return { profile, resume };
}

// Conservative — true only for the obvious "yes"; anything else defers to the
// judge.
//
// An uploaded resume FILE is intentionally not part of this (nor of the judge's
// input). What's load-bearing is the written background in resume.md, which is
// populated either by merging an upload in OR by Hank writing what the user said
// in chat. Gating on the file trapped resume-less users in profile mode forever.
export function isProfileEnrichedByLength(
  inventory: ProfileInventory,
): boolean {
  return (
    (inventory.profile ?? "").trim().length >= PROFILE_SHALLOW_THRESHOLD &&
    (inventory.resume ?? "").trim().length >= SHALLOW_THRESHOLD
  );
}

export async function isProfileObviouslyEnriched(
  userId: string,
): Promise<boolean> {
  return isProfileEnrichedByLength(await readProfileSlots(userId));
}
