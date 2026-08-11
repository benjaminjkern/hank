import { z } from "zod";

import { runReviewApplication } from "@/server/procedures/registry/draftApplication/reviewApplication";
import { buildApplicationEvents } from "@/server/views/showEvents";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// Read the application back as it now stands. Runs inline (a full read-back
// takes many seconds) — no handoff.
export const reviewApplicationTool: ToolDef<{ job?: string }> = {
  name: "review_application",
  affectsViewedState: true,
  description:
    "Read a role's application back against the résumé and the posting as it NOW stands, and get what came up. Use it after the user has changed the application — their panel edits arrive at the top of their message — or whenever they ask you to look it over again; nothing re-reads an application on its own, so a page that was checked before their edits has only been checked in its old form. It leaves the user's own writing alone (it reports on their sentences rather than rewriting them) and may tighten wording you drafted. Returns the reviewer's line about the application plus anything unresolved, each of which needs the USER to settle it. Relay what comes back in your own words — and never round 'one thing to check' up to 'ready to send'. Don't call it on an application nobody has touched since your last pass; you'd be paying to re-read the same words. `job` (the role's slug).",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
    },
  },
  parser: z.object({ job: z.string().optional() }),
  async handle(input, ctx) {
    const jobResolved = await resolveJobArg(ctx, input.job, {
      source: "review_application",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;
    const jobId = jobResolved.id;

    const result = await runReviewApplication({ ...ctx, jobId });

    if (result.failed) {
      return toolError(
        "SUB_AGENT_FAILED",
        "the read-back didn't finish, so nothing has checked this application. Say so plainly rather than implying it's clear.",
        "review_application:failed",
      );
    }
    if (!result.ran) {
      return {
        content:
          "Nothing is written on this application yet, so there was nothing to read back.",
      };
    }

    const parts: string[] = [];
    if (result.note.trim()) parts.push(result.note.trim());
    if (result.revisedTargets.length > 0) {
      parts.push(
        `Tightened wording you had drafted: ${result.revisedTargets.join(", ")}.`,
      );
    }
    if (result.open.length > 0) {
      parts.push(
        `Still unresolved — each is marked against its answer on the page, and each needs the USER to settle it (you can't). Tell them plainly what came up and leave the call to them:`,
        ...result.open.map((f) => `- ${f.label}: ${f.note}`),
      );
    } else {
      parts.push(
        "Nothing came up this time. You can tell them it reads clean as it stands.",
      );
    }

    const { events } = await buildApplicationEvents(ctx.userId, jobId);
    return { content: parts.join("\n"), events };
  },
};
