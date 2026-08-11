import { z } from "zod";

import { runDraftApplicationCollect } from "@/server/procedures/registry/draftApplication";
import { buildApplicationEvents } from "@/server/views/showEvents";

import { resolveJobArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

// On-demand trigger for the whole drafting workflow: fetch the form, decide
// what to draft, draft every draftable item, and run the recruiter-critic
// revision loop — the SAME engine the walkthrough fires automatically on job
// entry (runFormDrafting). Hank calls this when the user asks to draft/apply,
// or after registering a manually-described form via add_application_question.
// It writes to the application page and puts it on screen, never to
// chat; Hank narrates the summary it returns. Runs inline (drafting takes many seconds) — no handoff.
export const draftApplicationTool: ToolDef<{
  job?: string;
  extraContext?: string;
}> = {
  name: "draft_application",
  affectsViewedState: true,
  description:
    "Draft this job's whole application through the drafting workflow — it works out which questions it can draft, writes those + the cover letter (if the form wants one), and self-reviews them, all into the side panel. NEVER write application prose in chat yourself; call this instead. `job` (the role's slug) — pass the role the user means. `extraContext` (optional) passes along anything the user just told you to steer the whole application — an angle to emphasize, a fact to include, 'keep it short'. Returns a summary of what it drafted and any items that still need the user's own input. For redrafting or refining ONE specific answer, use draft_application_question.",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
      extraContext: {
        type: "string",
        description:
          "Optional free-text guidance from the user to steer the whole application (an angle, a fact to include, a tone). Omit if they gave none.",
      },
    },
    required: [],
  },
  parser: z.object({
    job: z.string().optional(),
    extraContext: z.string().optional(),
  }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobArg(ctx, input.job, {
      source: "draft_application",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;
    const jobId = jobResolved.id;

    const { result, notes } = await runDraftApplicationCollect({
      ...ctx,
      jobId,
      extraContext: input.extraContext,
      // extraContext already forces a re-decide inside the engine; also force it
      // so an explicit "draft this again" re-runs from scratch.
      forceRedecide: true,
    });

    // The form couldn't be read and the user hasn't described it by hand — point
    // at the manual path rather than pretending a draft exists.
    if (
      result.formUnavailable &&
      !result.hasCoverLetter &&
      result.answersCount === 0 &&
      result.askUserItems.length === 0
    ) {
      return {
        content:
          "I couldn't read this application form on my own. Ask the user what it asks, register each question with add_application_question, then draft — or they can just apply directly. (Do NOT claim a draft exists.)",
      };
    }

    const parts: string[] = [];
    const draftedCount = result.answersCount + (result.hasCoverLetter ? 1 : 0);
    if (draftedCount > 0) {
      parts.push(
        `Drafted into the side panel: ${result.hasCoverLetter ? "cover letter" : ""}${
          result.hasCoverLetter && result.answersCount ? " + " : ""
        }${result.answersCount ? `${result.answersCount} short answer${result.answersCount > 1 ? "s" : ""}` : ""}.`,
      );
    } else if (result.askUserItems.length === 0) {
      parts.push(
        "Nothing here needed a drafted answer — it's the kind of form the user fills in directly.",
      );
    }
    if (result.askUserItems.length > 0) {
      parts.push(
        `Still needs the user's own input (gather it in chat, then call draft_application_question with each, passing what they told you as extraContext): ${result.askUserItems
          .map((i) => `"${i}"`)
          .join(", ")}.`,
      );
    }
    // The read-back verdict, in Hank's own channel. He has to relay an
    // unresolved finding rather than report a finished draft — the whole point
    // of the reviewer is lost if its conclusion stops here.
    if (result.note) {
      parts.push(`The reviewer's line on it: ${result.note}`);
    }
    const open = result.review?.open ?? [];
    if (open.length > 0) {
      parts.push(
        `Read back against the résumé, and ${open.length === 1 ? "one thing is" : `${open.length} things are`} still unresolved — each is marked against its answer on the page, and each needs the USER to settle it (you can't). Tell them plainly what came up, in one sentence, and leave the call to them:`,
        ...open.map((f) => `- ${f.label}: ${f.note}`),
      );
    } else if (result.review?.outcome === "clean") {
      parts.push(
        "Read back against the résumé and the posting — nothing came up. You can tell them it's ready to look over.",
      );
    }
    if (result.notice) parts.push(result.notice);
    if (notes.length) parts.push(...notes);

    // Put the application on screen so "it's in the panel" is something the
    // user can see rather than a claim they have to go check.
    const { events } = await buildApplicationEvents(ctx.userId, jobId);
    return { content: parts.join("\n"), events };
  },
};
