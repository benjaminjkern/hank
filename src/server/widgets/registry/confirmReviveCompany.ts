// "Bring <company> back and check it?" — asked by the company walkthrough when
// it's entered on a CLOSED / BLOCKED company. Yes walks it with the revive in
// hand (the walkthrough does the revive itself, so typing "yes, bring it back"
// and Hank passing `revive: true` to company_walkthrough lands the same way);
// no leaves it set aside.

import { parseWidgetSubmission } from "../parse";

import type { WidgetAnswerDef } from "./types";

type ReviveAnswer = {
  kind: "confirm_revive_company";
  companyId: string;
  answer: "yes" | "no";
};

export const confirmReviveCompanyAnswer: WidgetAnswerDef<ReviveAnswer> = {
  parse: (message) => {
    const s = parseWidgetSubmission(message);
    return s?.kind === "confirm_revive_company" ? s : null;
  },
  answer: (submission) =>
    Promise.resolve(
      submission.answer === "yes"
        ? {
            next: {
              kind: "company_walkthrough",
              companyId: submission.companyId,
              revive: true,
            },
          }
        : { next: { kind: "show_whats_next" } },
    ),
};
