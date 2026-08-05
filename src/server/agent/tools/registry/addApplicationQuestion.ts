import { z } from "zod";

import { addUserQuestion } from "@/server/entities/jobs/applicationQuestions";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Register a question the user describes when the ATS form couldn't be scraped
// (login/SPA-gated, or an ATS we don't parse). Stored on the Job with
// provenance (who/when) and flagged user-added/unverified, so it shows in the
// job's application-form panel and is merged with the scraped set everywhere.
// After adding, draft it with draft_application (whole form) or
// draft_application_question (this one), passing the user's material as extraContext.
export const addApplicationQuestionTool: ToolDef<{
  job?: string;
  question: string;
  questionType?: string;
}> = {
  name: "add_application_question",
  affectsViewedState: true,
  description:
    'Register an application question the user tells you about when you couldn\'t read the form automatically (login-gated / unsupported ATS). `question` is the question text as the form asks it (for the cover letter, phrase it as "Cover letter"). `questionType` (optional) is the kind of field — e.g. "textarea" for a long prose box, "select" for a dropdown — if the user says. `job` (the role\'s slug) — pass the role the user means. It\'s saved on the role and shows in its application-form panel, marked as added-by-hand. Returns the new questionId; then draft it with draft_application or draft_application_question.',
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      question: {
        type: "string",
        description:
          'The question text as the form asks it. Use "Cover letter" for a cover-letter field.',
      },
      questionType: {
        type: "string",
        description:
          'Optional field kind — e.g. "textarea" (long prose), "text" (short), "select" (dropdown). Omit if unknown.',
      },
    },
    required: ["question"],
  },
  parser: z.object({
    job: z.string().optional(),
    question: z.string().min(1),
    questionType: z.string().optional(),
  }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobArg(ctx, input.job, {
      source: "add_application_question",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;
    const jobId = jobResolved.id;

    const r = await addUserQuestion(
      ctx.userId,
      jobId,
      input.question.trim(),
      input.questionType?.trim() || undefined,
    );
    if (!r.ok) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no job found for that slug.`,
        "add_application_question:not_found:job",
      );
    }
    return {
      content: r.alreadyPresent
        ? `That question is already on the form (id ${r.id}) — draft it with draft_application_question.`
        : `Added the question (id ${r.id}). Draft it with draft_application_question (pass what the user tells you as extraContext), or draft the whole form with draft_application.`,
    };
  },
};
