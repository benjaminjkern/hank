import { defineWidget } from "../defineWidget";

import type { ShortlistScanGatePayload } from "../../types";

// No text projection and no harness binding: this gate only fires when a
// shortlist is requested out-of-band with un-scanned NEW roles left; in a
// normal walkthrough the scan step already drained NEW, so it never persists
// into replay and never reaches the QA persona. Writing `toText: null` states
// that rather than leaving a gap.
export const shortlistScanGateDef = defineWidget<ShortlistScanGatePayload>({
  kind: "shortlist_scan_gate",
  toText: null,
});
