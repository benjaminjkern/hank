// Stable ids for the items on an application form.
//
// Application questions have no stored id — they're keyed by TEXT everywhere
// (normalizeForCompare). `questionId` is a deterministic accessor over that same
// key, so a tool or a panel button can name ONE item without quoting long
// question text back, and the id survives a form re-fetch or reorder. The cover
// letter has its own column rather than being a question, so it gets a reserved
// pseudo-id.
//
// Its own file because the form service and the draft-authorship rules both
// need it, and they need each other in the other direction.

import { fnv1a } from "@/utils/hash";
import { normalizeForCompare } from "@/utils/text";

// Never collides with a real questionId (those are `q_…`).
export const COVER_LETTER_ID = "cover_letter";

export function questionId(text: string): string {
  return `q_${fnv1a(normalizeForCompare(text))}`;
}
