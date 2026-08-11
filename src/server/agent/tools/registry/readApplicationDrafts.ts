import { z } from "zod";

import { isStockItem } from "@/lib/applicationItem";
import {
  loadApplicationView,
  type ApplicationItemStatus,
} from "@/server/views/application";

import { resolveJobArg } from "../lib/resolveEntityArg";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

// What an unwritten item says instead of its text — the reason it's empty is
// the useful thing there, not the absence.
const WHEN_EMPTY: Record<ApplicationItemStatus, string> = {
  written_by_you: "(empty)",
  drafted: "(empty)",
  needs_you: "(nothing written — waiting on something only they can tell you)",
  empty: "(nothing written)",
};

export const readApplicationDraftsTool: ToolDef<{ job?: string }> = {
  name: "read_application_drafts",
  description:
    "Read the cover letter and short-answer responses already drafted/saved for a job, so you can quote, summarize, or revise them with the user. `job` (the role's slug) is the role the user means (pass a different slug to read another job's drafts — use list_jobs / list_companies to find it). Returns the full cover-letter text and every short-answer question + answer, noting which the user has already worked on vs. which are still just a draft Hank wrote. Call this whenever the user asks about, wants to see, or wants to change what's been written for an application — don't say you can't see it.",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description: "The role's slug — the role the user means.",
      },
    },
    required: [],
  },
  parser: z.object({ job: z.string().optional() }),
  async handle({ job: jobSlug }, ctx) {
    const jobResolved = await resolveJobArg(ctx, jobSlug, {
      source: "read_application_drafts",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;

    const view = await loadApplicationView(ctx.userId, jobResolved.id);
    if (!view) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no application record found for that job (nothing has been drafted or saved for it yet).`,
        "read_application_drafts:not_found:job_interaction",
      );
    }

    const parts: string[] = [`# ${view.jobTitle} @ ${view.companyName}`];
    for (const item of view.items) {
      // Stock fields are summarised at the end. Listed here as empty items they
      // read as unfinished work — which is exactly how they got reported back
      // to the user as "several questions are still blank".
      if (isStockItem(item)) continue;
      const heading =
        item.kind === "cover_letter"
          ? "## Cover letter"
          : `**Q:** ${item.label}`;
      if (!item.text?.trim()) {
        parts.push("", heading, WHEN_EMPTY[item.status]);
        continue;
      }
      const owner =
        item.status === "written_by_you"
          ? "their own words — don't rewrite these"
          : "your draft, as written";
      const edited = item.edited ? ", changed since you last saw it" : "";
      parts.push("", heading, `(${owner}${edited})`, item.text.trim());
    }

    const stock = view.items.filter(isStockItem);
    if (stock.length > 0) {
      parts.push(
        "",
        `Plus ${stock.length} stock field${stock.length === 1 ? "" : "s"} the user fills in directly on the posting — nothing to draft, and NOT unfinished work: ${stock
          .map((i) => i.label)
          .join(", ")}.`,
      );
    }

    return { content: parts.join("\n") };
  },
};
