import { defineWidget, normRef, widgetMarker } from "../defineWidget";

import type { ConfirmApplicationSubmitPayload } from "../../types";

export const confirmApplicationSubmitDef =
  defineWidget<ConfirmApplicationSubmitPayload>({
    kind: "confirm_application_submit",
    toText: (p) => {
      const subject =
        [p.jobTitle, p.companyName].filter(Boolean).join(" at ") || "this role";
      return `[Hank is confirming you actually submitted the application for ${subject}.\n  "confirm" if you sent it]`;
    },
    harness: {
      actionHint:
        'widget_action with optionRef = "confirm" if you submitted it. Or send_message (e.g. to say you have not yet).',
      multiSelect: false,
      translate: (p, action) => {
        const subject =
          [p.jobTitle, p.companyName].filter(Boolean).join(" at ") ||
          "this role";
        const r = normRef(action.optionRef);
        if (!(r.startsWith("conf") || r === "yes" || r === "1")) {
          return {
            error: `confirm_application_submit only accepts a confirm action; got: ${action.optionRef}`,
          };
        }
        return widgetMarker(
          { kind: "confirm_application_submit", jobId: p.jobId },
          `[Confirmed submitted: ${subject}]`,
        );
      },
    },
  });
