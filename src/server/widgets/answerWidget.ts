// The ONE place a click-sent message is recognized: a widget answer or a panel's
// "Looks good". Runs before Hank, because a structured choice commits
// deterministically — there's nothing for the LLM to route. Returns null when
// the message isn't one (or the click's claim no longer holds), and the message
// goes to Hank as ordinary text.
//
// Every answer here ends the same way any step does — by naming what runs next
// — so the chat loop runs it like any other entry. Nothing here writes the
// user's row; runChat already did.

import type { StepArgs, StepOutcome } from "@/server/contracts";

import { commitNegotiationAnswer } from "../panels/commitNegotiation";

import { addMoreCompaniesAnswer } from "./registry/addMoreCompanies";
import { companyDisambiguationAnswer } from "./registry/companyDisambiguation";
import { confirmApplicationSubmitAnswer } from "./registry/confirmApplicationSubmit";
import { confirmReviveCompanyAnswer } from "./registry/confirmReviveCompany";
import { nextCompanyPickerAnswer } from "./registry/nextCompanyPicker";
import { nextJobPickerAnswer } from "./registry/nextJobPicker";

import type { WidgetAnswerDef } from "./registry/types";

// Bind each def's parse to its answer, so the list can hold defs of different
// answer types without a cast.
function answering<T>(def: WidgetAnswerDef<T>) {
  return (
    message: string,
    args: StepArgs,
  ): Promise<StepOutcome | null> | null => {
    const parsed = def.parse(message);
    return parsed === null ? null : def.answer(parsed, args);
  };
}

// Each parser keys on its own marker, so at most one matches.
const ANSWERS = [
  answering(nextCompanyPickerAnswer),
  answering(nextJobPickerAnswer),
  answering(confirmReviveCompanyAnswer),
  answering(confirmApplicationSubmitAnswer),
  answering(addMoreCompaniesAnswer),
  answering(companyDisambiguationAnswer),
  answering(commitNegotiationAnswer),
];

export async function answerWidget(
  args: StepArgs & { userMessage: string },
): Promise<StepOutcome | null> {
  const { userMessage, ...stepArgs } = args;
  let answered: Promise<StepOutcome | null> | null = null;
  for (const tryAnswer of ANSWERS) {
    answered = tryAnswer(userMessage, stepArgs);
    if (answered) break;
  }
  return answered ? await answered : null;
}
