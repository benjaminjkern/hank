import { z } from "zod";

import { loadMergedQuestions } from "@/server/entities/jobs/applicationQuestions";
import { needsQuestionsRefresh } from "@/server/entities/jobs/questionsRefresh";
import { ensureApplicationForm } from "@/server/procedures/registry/draftApplication/ensureApplicationForm";
import {
  loadApplicationView,
  type ApplicationItemStatus,
} from "@/server/views/application";

import { resolveJobArg } from "../lib/resolveEntityArg";

import type { ToolDef } from "../lib/types";

// The human phrasing for each item status — presentation for the enum the
// application view derives.
const STATUS_LABEL: Record<ApplicationItemStatus, string> = {
  written_by_you: "the user wrote or reworked this",
  drafted: "drafted by you; the user hasn't touched it",
  needs_you: "needs the user's own input",
  empty: "nothing written yet",
};

// The "what does this application ask, and where does each item stand" index.
// It's the tool that mints the questionIds draft_application_question consumes —
// distinct from read_application_drafts (only shows what's WRITTEN, no
// undrafted questions, no ids). Same payload the user's application page
// renders, so what you report and what they see can't drift.
//
// Self-healing: this is the tool that most directly answers "what does this
// application ask", so it must never report "no questions" for a form it never
// read. If the ATS form has never been fetched (envelope === null) and nobody
// described it by hand, it lazily fetches via ensureApplicationForm first — the
// SAME cached path the drafting procedure uses — then reports the real state. A
// fresh envelope (already fetched) is a no-op, so the fetch fires only in the
// never-read case, which would otherwise render as a confident "no prose
// questions". Because that fetch persists Job.applicationQuestions,
// the tool is affectsViewedState. The derivation itself lives in
// loadApplicationView; the tool renders.
export const viewApplicationQuestionsTool: ToolDef<{ job?: string }> = {
  name: "view_application_questions",
  affectsViewedState: true,
  description:
    "List every question this job's application form asks — the scraped ATS questions plus any you added by hand — each with a stable questionId, and where it stands (already drafted, the user has worked on it, still needs input, or nothing to draft). Reads the form on first call if it hasn't been fetched yet (so it never claims a form has no questions without having read it), then caches. Use it to see the form and to get the questionId to pass to draft_application_question. `job` (the role's slug) — pass the role the user means. The questionId is for tool calls ONLY — never say it (or a number) to the user; refer to a question by quoting its text.",
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
      source: "view_application_questions",
      ambiguousMessage: "no job slug provided — pass the role's slug",
    });
    if (!jobResolved.ok) return jobResolved.result;
    const jobId = jobResolved.id;

    // Self-heal: fetch the form if it's never been read (or a stale error/
    // unsupported envelope is due a retry) and nobody's described it by hand.
    // ensureApplicationForm re-checks needsQuestionsRefresh internally, so this
    // is a no-op on an already-fetched form.
    const merged = await loadMergedQuestions(jobId);
    if (
      needsQuestionsRefresh(merged.envelope) &&
      merged.userAddedQuestions.length === 0
    ) {
      await ensureApplicationForm({ jobId });
    }

    const view = await loadApplicationView(ctx.userId, jobId);
    if (!view) {
      return {
        content: `no application record found for that job.`,
      };
    }
    if (view.formUnreadable) {
      // Scrape failed / no application URL, and nobody's added a question by
      // hand — say so plainly and point at the manual path (NEVER "no questions").
      return {
        content: `# ${view.jobTitle} @ ${view.companyName}\n\nI couldn't read this application form automatically (its apply page is login-gated, on an ATS I can't parse, or there's no application link on file). If you tell me what it asks, I'll register each question with add_application_question and draft the answers — otherwise you can just apply directly.`,
      };
    }

    const lines: string[] = [`# ${view.jobTitle} @ ${view.companyName}`, ""];

    if (view.formEmpty) {
      // Reachable only after the form HAS been read (the never-fetched / unread
      // cases returned above), so this is a genuine fetched-empty form.
      lines.push(
        "(I read this form — it has no custom questions to draft, just the standard fields the user fills in directly.)",
      );
    } else {
      for (const item of view.items) {
        const label =
          item.kind === "cover_letter" ? "Cover letter" : `"${item.label}"`;
        const req = item.required ? " (required)" : "";
        const src =
          item.source === "user" ? " · added by hand (unverified)" : "";
        const edited = item.edited ? " · edited since you last saw it" : "";
        lines.push(
          `- [${item.id}] ${label}${req}${src} — ${STATUS_LABEL[item.status]}${edited}`,
        );
      }
    }

    lines.push(
      "",
      "Use the id in [brackets] with draft_application_question to draft or redraft one item. Quote the question text (never the id or a number) when you talk to the user.",
    );

    return { content: lines.join("\n") };
  },
};
