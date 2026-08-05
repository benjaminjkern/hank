// Read one PAST application's reusable cover letter + short answers, so a
// drafting sub-agent can match the user's voice instead of inventing one.
//
// Sub-agent-only — not in `hankToolsFor`. Deliberately NOT the same thing as
// `read_application_drafts`, which Hank uses: that one shows EVERY artifact for
// a job (annotated with whether the user has worked on it) so it can be
// reviewed and revised. This one returns only artifacts the user marked
// REUSABLE, from a DIFFERENT job, as raw material. The filter is the whole
// point — without it the drafter reads its own unvalidated prior drafts and
// bootstraps on its own voice. It was called `read_past_application`, a name
// that made the two sound interchangeable.

import { z } from "zod";

import { loadReusableApplication } from "@/server/entities/jobs/pastDrafts";
import { resolveJobBySlug } from "@/server/entities/resolveBySlug";

import type { ToolDef } from "../lib/types";

export const readReusableApplicationTool: ToolDef<{ job: string }> = {
  name: "read_reusable_application",
  description:
    "Read the user's full prior application artifacts (cover letter + short answers) for a PAST application, addressed by the role's slug — the `job=…` slug shown next to each entry in the front-loaded 'past cover letters' / 'past short answers' indexes. Returns only what the user marked reusable, which is exactly the material worth adapting. Feeding a full prior draft into your context is the cheapest way to match the user's voice and adapt phrasing.",
  inputSchema: {
    type: "object",
    properties: {
      job: {
        type: "string",
        description:
          "The role slug from the `job=…` marker in the front-loaded past-drafts index.",
      },
    },
    required: ["job"],
  },
  parser: z.object({ job: z.string() }),
  affectsViewedState: false,
  async handle({ job }, ctx) {
    const resolved = await resolveJobBySlug(ctx.userId, job);
    if (!resolved.ok) {
      return { content: `(no prior application found for ${job})` };
    }
    const application = await loadReusableApplication(
      ctx.userId,
      resolved.value.id,
    );
    if (!application) {
      return { content: `(no prior application found for ${job})` };
    }

    const parts: string[] = [
      `# ${application.jobTitle} @ ${application.companyName}`,
      "",
      "## Cover letter",
      application.coverLetter ?? "(none reusable)",
    ];
    if (application.shortAnswers.length) {
      parts.push("", "## Short answers");
      for (const { question, answer } of application.shortAnswers) {
        parts.push("", `**Q:** ${question}`, `**A:** ${answer}`);
      }
    } else {
      parts.push("", "## Short answers", "(none reusable)");
    }
    return { content: parts.join("\n") };
  },
};
