// "Find more / Done adding" after a discovery round settles. More asks what to
// look for this time before searching — they've just seen a batch, so "more"
// with no steer returns names adjacent to the ones they passed on. Done is a
// topic boundary, the same event the end of a company is, so it files the round
// away — but only when the round decided something: opening discovery and
// backing straight out is not a boundary, and the wrap-up costs two LLM calls.
// Typed equivalents: find_companies / show_whats_next.

import type { StepOutcome } from "@/server/contracts";

import { parseAddMoreCompaniesSubmission } from "../parse";

import type { WidgetAnswerDef } from "./types";

// "Find more" says they want another round, not what it should contain.
const FIND_MORE_NUDGE =
  "(They just finished adding companies and want another round. Ask what to look for this time — a different sector, stage, or angle from the batch they just saw. Don't search yet.)";

type AddMoreAnswer = NonNullable<
  ReturnType<typeof parseAddMoreCompaniesSubmission>
>;

export const addMoreCompaniesAnswer: WidgetAnswerDef<AddMoreAnswer> = {
  parse: parseAddMoreCompaniesSubmission,
  answer: (submission): Promise<StepOutcome> =>
    Promise.resolve(
      submission.answer === "yes"
        ? { next: { kind: "hank", nudge: FIND_MORE_NUDGE } }
        : {
            next: { kind: "show_whats_next" },
            ...(submission.settled > 0 ? { ended: "discovery" as const } : {}),
          },
    ),
};
