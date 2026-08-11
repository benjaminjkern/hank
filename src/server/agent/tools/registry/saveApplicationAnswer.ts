import { z } from "zod";

import { persistApplicationAnswer } from "@/server/entities/jobs/applicationQuestions";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const saveApplicationAnswerTool: ToolDef<{
  job?: string;
  coverLetter?: string;
  question?: string;
  answer?: string;
}> = {
  name: "save_application_answer",
  affectsViewedState: true,
  description:
    "Persist a user's OWN VERBATIM application text — ONLY when they hand you the exact words to save (\"just put exactly this: …\"). It transcribes; it does not compose, and it does not shape what they said into an answer. Anything you write or refine — including an answer built from what they just told you in chat — goes through draft_application_question with their input as `extraContext`. Pass `coverLetter` to save/replace the cover letter, and/or `question` + `answer` to save one short answer (pass the question text exactly as the form shows it — it's matched to the form's question). `job` (the role's slug) — pass the role the user means. Merges (won't wipe sibling short answers) and saves early so the user sees it in the side panel right away.",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      coverLetter: {
        type: "string",
        description:
          "Full cover-letter content (markdown ok). Replaces any existing cover letter.",
      },
      question: {
        type: "string",
        description:
          "The application question text, exactly as shown on the form. Required when saving a short answer.",
      },
      answer: {
        type: "string",
        description:
          "The answer to `question`. Required when saving a short answer.",
      },
    },
  },
  parser: z
    .object({
      job: z.string().optional(),
      coverLetter: z.string().optional(),
      question: z.string().optional(),
      answer: z.string().optional(),
    })
    .refine((v) => !!v.coverLetter || (!!v.question && !!v.answer), {
      message: "provide coverLetter and/or (question AND answer)",
    }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobArg(ctx, input.job, {
      source: "save_application_answer",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;
    const jobId = jobResolved.id;

    // Their words, so the page attributes it to them. It does NOT touch the
    // reuse flag: that switch lives on the application page, and flipping it
    // from a chat message would be a change the user has no way to see happen.
    const r = await persistApplicationAnswer(ctx.userId, jobId, {
      coverLetter: input.coverLetter,
      question: input.question,
      answer: input.answer,
      author: "user",
    });
    if (!r.ok) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no JobInteraction found for that job`,
        "save_application_answer:not_found:job_interaction",
      );
    }
    return { content: `saved ${r.applied.join(" + ")} for ${r.jobSlug}` };
  },
};
