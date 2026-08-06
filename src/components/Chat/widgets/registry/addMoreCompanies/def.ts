import { defineWidget, normRef, widgetMarker } from "../defineWidget";

import type { AddMoreCompaniesPayload } from "../../types";

export const addMoreCompaniesDef = defineWidget<AddMoreCompaniesPayload>({
  kind: "add_more_companies",
  toText: (p) => {
    const added = p.addedThisBatch.length
      ? p.addedThisBatch.join(", ")
      : "(none)";
    return `[Added to your watchlist: ${added}.\n  Add more companies? "yes" / "no"]`;
  },
  harness: {
    actionHint:
      'widget_action with optionRef = "yes" or "no". Or send_message.',
    multiSelect: false,
    translate: (_p, action) => {
      const r = normRef(action.optionRef);
      const answer = r.startsWith("y")
        ? "yes"
        : r.startsWith("n")
          ? "no"
          : null;
      if (!answer)
        return {
          error: `unrecognized add_more_companies optionRef: ${action.optionRef}`,
        };
      return widgetMarker(
        { kind: "add_more_companies", answer },
        answer === "yes" ? "[Add more]" : "[Done adding]",
      );
    },
  },
});
