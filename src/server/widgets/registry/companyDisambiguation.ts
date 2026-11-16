// The user resolved a name collision the board hunt flagged while adding
// companies: commit each chosen board, then ask the same add-more question,
// since this is the tail of the same add. Typed equivalent: update_company with
// the right careers URL, then enrich_companies.

import type { StepOutcome } from "@/server/contracts";
import {
  addMoreCompaniesWidget,
  runDisambiguationResolution,
} from "@/server/procedures/registry/enrichCompanies";

import { parseCompanyDisambiguationSubmission } from "../parse";

import type { WidgetAnswerDef } from "./types";

type DisambiguationAnswer = NonNullable<
  ReturnType<typeof parseCompanyDisambiguationSubmission>
>;

export const companyDisambiguationAnswer: WidgetAnswerDef<DisambiguationAnswer> =
  {
    parse: parseCompanyDisambiguationSubmission,
    answer: async (submission, args): Promise<StepOutcome> => {
      const added = await runDisambiguationResolution({
        ...args,
        resolved: submission.resolved,
      });
      await args.say(addMoreCompaniesWidget(added, 0));
      return {};
    },
  };
