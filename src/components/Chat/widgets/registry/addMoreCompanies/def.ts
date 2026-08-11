import { defineWidget, normRef, widgetMarker } from "../defineWidget";

import type { AddMoreCompaniesPayload } from "../../types";

export const addMoreCompaniesDef = defineWidget<AddMoreCompaniesPayload>({
  kind: "add_more_companies",
  toText: (p) => {
    const added = p.addedThisBatch.length
      ? p.addedThisBatch.join(", ")
      : "(none)";
    return `[Added to your watchlist: ${added}.\n  Done adding, or find more companies? "done" / "more"]`;
  },
  harness: {
    actionHint:
      'widget_action with optionRef = "done" (move on) or "more" (keep looking). Or send_message.',
    multiSelect: false,
    translate: (p, action) => {
      const r = normRef(action.optionRef);
      // "yes" = keep hunting, matching the submission's answer field; the
      // labels the user sees are Done / Find more.
      const answer = r.startsWith("m")
        ? "yes"
        : r.startsWith("d") || r.startsWith("n")
          ? "no"
          : null;
      if (!answer)
        return {
          error: `unrecognized add_more_companies optionRef: ${action.optionRef}`,
        };
      return widgetMarker(
        {
          kind: "add_more_companies",
          answer,
          settled: p.addedThisBatch.length + (p.passedCount ?? 0),
        },
        answer === "yes" ? "[Find more]" : "[Done adding]",
      );
    },
  },
});
