import { z } from "zod";

import {
  resolveQuestionId,
  persistApplicationAnswer,
} from "@/server/entities/jobs/applicationQuestions";
import { draftSingleApplicationItem } from "@/server/procedures/registry/draftApplication/draftSingleApplicationItem";
import { buildApplicationEvents } from "@/server/views/showEvents";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Draft or redraft ONE application item through the drafting workflow. This is
// the tool that replaces Hank writing answer prose in chat: once Hank has
// gathered what it needs from the user (a story, an angle, a fact — or just
// "make it shorter"), it hands that to this tool as extraContext and the
// workflow writes the answer in the user's voice into the side panel. Use the
// questionId from view_application_questions, or the reserved "cover_letter".
// Persisted as user-owned content (survives submit, re-surfaces for reuse).
export const draftApplicationQuestionTool: ToolDef<{
  job?: string;
  questionId: string;
  extraContext?: string;
}> = {
  name: "draft_application_question",
  affectsViewedState: true,
  description:
    'Draft or redraft ONE application answer through the drafting workflow — never write the answer prose in chat yourself. Pass the `questionId` from view_application_questions (or "cover_letter" for the cover letter) and, in `extraContext`, whatever the user just told you to build the answer on: a story, an angle, a fact, or a refinement like "make it shorter" / "less formal". The workflow writes it in their voice into the side panel; show it to them and refine by calling again with more context. `job` (the role\'s slug) — pass the role the user means.',
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      questionId: {
        type: "string",
        description:
          'The question\'s id from view_application_questions, or "cover_letter" for the cover letter.',
      },
      extraContext: {
        type: "string",
        description:
          "What the user told you to build this answer on — their story/angle/fact, or a refinement instruction. Strongly recommended; the workflow leans on it as the primary material.",
      },
    },
    required: ["questionId"],
  },
  parser: z.object({
    job: z.string().optional(),
    questionId: z.string(),
    extraContext: z.string().optional(),
  }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobArg(ctx, input.job, {
      source: "draft_application_question",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;
    const jobId = jobResolved.id;

    const resolved = await resolveQuestionId(jobId, input.questionId);
    if (!resolved) {
      return toolError(
        "INVALID_INPUT",
        `no application question with id "${input.questionId}" on this job — call view_application_questions to see the current ids (or add_application_question if it's a question the form asks that isn't listed).`,
        "draft_application_question:not_found:question_id",
      );
    }

    const isCover = resolved.kind === "cover_letter";
    // The drafter invocation + empty-guard is the shared core; this tool owns
    // the user-owned persistence below.
    const drafted = await draftSingleApplicationItem({
      ...ctx,
      jobId,
      item: isCover
        ? { kind: "cover_letter" }
        : { kind: "question", text: resolved.text },
      extraContext: input.extraContext,
    });
    if (!drafted.ok) {
      return toolError(
        "SUB_AGENT_FAILED",
        `couldn't draft that answer: ${drafted.error}`,
        "draft_application_question:subagent_failed",
      );
    }

    // Persisted reuse:false like any agent draft — the user supplied the angle
    // via extraContext, but the words are still Hank's until they claim them.
    const persisted = await persistApplicationAnswer(
      ctx.userId,
      jobId,
      isCover
        ? { coverLetter: drafted.content }
        : { question: resolved.text, answer: drafted.content },
    );
    if (!persisted.ok) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no application record found for that job.`,
        "draft_application_question:not_found:job_interaction",
      );
    }

    const label = isCover ? "the cover letter" : `"${resolved.text}"`;
    const { events } = await buildApplicationEvents(ctx.userId, jobId);
    return {
      content: `Drafted ${label} onto the application page for ${persisted.jobSlug} and put it on the user's screen. Refine with another draft_application_question call if they want changes.`,
      events,
    };
  },
};
