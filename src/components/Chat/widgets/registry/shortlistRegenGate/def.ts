import { defineWidget } from "../defineWidget";

import type { ShortlistRegenGatePayload } from "../../types";

// No text projection and no harness binding — same rationale as the scan gate:
// this only fires when a shortlist is requested on a company that already has
// one, out-of-band; it never persists into replay and never reaches the QA
// persona. Writing `toText: null` states that rather than leaving a gap.
export const shortlistRegenGateDef = defineWidget<ShortlistRegenGatePayload>({
  kind: "shortlist_regen_gate",
  toText: null,
});
