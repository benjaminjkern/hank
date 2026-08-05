// The profileEnrichmentCheck sub-agent's input: the two load-bearing profile
// slots, verbatim. Nothing countable is derived here — the judge only ever rules
// on substance, and the length pre-gate the caller applies is a rule over this
// same read (see entities/profile/profileInventory.ts).

import { readProfileSlots } from "@/server/entities/profile/profileInventory";
import type { ProfileEnrichmentCheckInput } from "@/server/subagents/registry/profileEnrichmentCheck";

export async function loadProfileEnrichmentCheckInput(
  userId: string,
): Promise<ProfileEnrichmentCheckInput> {
  return { inventory: await readProfileSlots(userId) };
}
