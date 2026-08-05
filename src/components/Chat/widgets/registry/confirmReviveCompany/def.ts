import { defineWidget, normRef, widgetMarker } from "../defineWidget";

import type { ConfirmReviveCompanyPayload } from "../../types";

export const confirmReviveCompanyDef =
  defineWidget<ConfirmReviveCompanyPayload>({
    kind: "confirm_revive_company",
    toText: (p) => {
      const name = p.companyName ?? "this company";
      return (
        `[${name} was set aside earlier.` +
        `${p.reasoning ? ` ${p.reasoning}` : ""}\n  "revive" to bring it back and continue, "no" to leave it set aside]`
      );
    },
    harness: {
      actionHint:
        'widget_action with optionRef = "revive" or "no". Or send_message.',
      multiSelect: false,
      translate: (p, action) => {
        const name = p.companyName ?? "this company";
        const r = normRef(action.optionRef);
        const answer =
          r.startsWith("revive") || r === "yes" || r.startsWith("continue")
            ? "yes"
            : r === "no" || r.startsWith("leave") || r.startsWith("not")
              ? "no"
              : null;
        if (!answer)
          return {
            error: `unrecognized confirm_revive_company optionRef: ${action.optionRef}`,
          };
        return widgetMarker(
          { kind: "confirm_revive_company", companyId: p.companyId, answer },
          answer === "yes" ? `[Revive ${name}]` : `[Leave ${name} set aside]`,
        );
      },
    },
  });
