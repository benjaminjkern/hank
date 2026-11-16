import type { StepArgs, StepOutcome } from "@/server/contracts";

// One kind of answer the user can send by clicking instead of typing: a widget
// button, or a panel's "Looks good". `parse` recognizes the marker the click
// sends as its message; `answer` does at most the one write the answer IS (a
// revive, a submitted application) and names what runs next.
//
// An answer never RUNS work beyond that write — it hands off, and the chat loop
// runs the entry like any other. That is what lets the same entry be reached by
// typing: every answer here has a tool Hank can queue for the same result, so a
// user who types "yes, bring it back" instead of clicking ends up in the same
// place.
//
// `answer` returns null to decline: the claim behind the click no longer holds
// (a stale "Looks good"), so the message goes to Hank as ordinary text instead.
export type WidgetAnswerDef<T> = {
  parse: (message: string) => T | null;
  answer: (answer: T, args: StepArgs) => Promise<StepOutcome | null>;
};
