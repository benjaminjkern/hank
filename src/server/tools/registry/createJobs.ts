import { z } from "zod";

import { prisma } from "@/server/db/prisma";
import {
  createJobs,
  type CreateJobInput,
} from "@/server/entities/jobs/createJobs";
import {
  resolveCompaniesBySlug,
  resolveOpportunitiesBySlug,
} from "@/server/entities/resolveBySlug";
import { normalizeUrlInput } from "@/shared/utils/url";

import { toolError } from "../../platform/agentLoop/toolError";
import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

// -- create_jobs / update_job --------------------------------------------
//
// Manual entry point for jobs that don't come from a careers-page scrape:
// referrals, email-only postings, historical applications the user is
// logging long after the fact, batches of recruiter pitches. Batched by
// design — one tool call → one Postgres transaction, one narration line.
// Title is the only required field per item.

const CreateJobItemSchema = z.object({
  company: z
    .string()
    .optional()
    .describe(
      "Hiring company slug (e.g. 'stripe'), as shown in list_jobs / list_companies. Leave blank only when there's genuinely no company yet (agency-pitched role with an undisclosed client) — then pass `opportunity`, plus `companyName` for the human-readable label.",
    ),
  companyName: z
    .string()
    .optional()
    .describe(
      "Human-readable company name when `company` is null (e.g. 'undisclosed fintech'). Ignored if `company` is set. Becomes a real Company later via create_companies + update_job({company}).",
    ),
  opportunity: z
    .string()
    .optional()
    .describe(
      "Slug of an existing lead (Opportunity) to link this Job to. The new role is created at status=PITCHED (no SURFACED event) and shows up under the lead in the right panel. Scan-flow / referral / email-only jobs leave this blank.",
    ),
  title: z
    .string()
    .min(1)
    .describe(
      'Role title. If the user didn\'t give one verbatim, infer one from context (e.g. "Senior Engineer (referral)"). Required.',
    ),
  sourceUrl: z
    .string()
    .transform(normalizeUrlInput)
    .pipe(z.string().url())
    .optional()
    .describe(
      "Optional. URL to the public posting. Omit if the job is a referral / email-only / private.",
    ),
  rawContent: z
    .string()
    .optional()
    .describe(
      "Optional. Posting body or whatever description the user gave you. Markdown ok. Use update_job later to refine.",
    ),
  location: z.string().optional().describe("Optional. e.g. 'NYC (Remote)'."),
  department: z.string().optional().describe("Optional. e.g. 'Engineering'."),
  compensation: z
    .string()
    .optional()
    .describe("Optional. e.g. '$180K – $240K'."),
  employmentType: z
    .string()
    .optional()
    .describe("Optional. 'Full-time' / 'Contract' / 'Part-time' etc."),
});

type CreateJobItem = z.infer<typeof CreateJobItemSchema>;

export const createJobsTool: ToolDef<{ jobs: CreateJobItem[] }> = {
  name: "create_jobs",
  affectsViewedState: true,
  description:
    "Create one or more Job records manually from chat. Batched — pass an array; everything lands in one transaction (all-or-nothing). Per-item flavors: (1) scan-flow / referral / email-only — pass `company` (the hiring company's slug), creates JobInteraction(NEW) + SURFACED event; (2) recruiter pitch — pass `opportunity` (the lead's slug) to link to it, creates JobInteraction(PITCHED) and no SURFACED event. Each item's title is required — infer from context if the user didn't give one verbatim. Use this for the 'log 5 historical applications' case: call create_jobs once with all 5, then mark_job_applied or log_job_events on each job by the slug it returns. For a single create, still pass an array of length 1.",
  parser: z.object({ jobs: z.array(CreateJobItemSchema).min(1) }),
  async handle({ jobs }, ctx) {
    // Pre-validate each item against the live DB before opening a transaction.
    // Rollback-on-any-error is the chosen semantics; surfacing per-item misuse
    // before the txn is cleaner than a transaction abort + opaque content.
    type ResolvedItem = {
      raw: CreateJobItem;
      companyId: string | null;
      companyName: string | null;
      companySlug: string | null;
      opportunityId: string | null;
    };
    // Every lookup the batch needs, resolved up front in one query per entity
    // type — not one per job. The loop below is then pure (it only reads these
    // maps), so a 20-job create costs the same round trips as a 1-job create.
    const companySlugs = [
      ...new Set(jobs.map((j) => j.company).filter((c): c is string => !!c)),
    ];
    const opportunitySlugs = [
      ...new Set(
        jobs.map((j) => j.opportunity).filter((o): o is string => !!o),
      ),
    ];
    const sourceUrls = jobs
      .map((j) => j.sourceUrl)
      .filter((u): u is string => !!u);
    const [companyBySlug, opportunityBySlug, existingJobs] = await Promise.all([
      resolveCompaniesBySlug(ctx.userId, companySlugs),
      resolveOpportunitiesBySlug(ctx.userId, opportunitySlugs),
      sourceUrls.length > 0
        ? prisma.job.findMany({
            where: { sourceUrl: { in: sourceUrls } },
            select: { id: true, title: true, slug: true, sourceUrl: true },
          })
        : Promise.resolve([]),
    ]);
    const existingJobByUrl = new Map(
      existingJobs.map((j) => [j.sourceUrl as string, j]),
    );

    const resolved: ResolvedItem[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const input = jobs[i];
      let companyId: string | null = null;
      let companyName: string | null = null;
      let companySlug: string | null = null;

      if (input.company) {
        const r = companyBySlug.get(input.company)!;
        if (!r.ok) return slugLookupError(r, { itemPrefix: `item ${i}: ` });
        companyId = r.value.id;
        companyName = r.value.name;
        companySlug = r.value.slug;
      }

      if (!companyId) {
        if (input.companyName) {
          companyName = input.companyName;
        } else if (!input.opportunity) {
          return toolError(
            "AMBIGUOUS_INPUT",
            `item ${i} ("${input.title}"): needs a target company. Pass a company slug, or pass an opportunity slug (for an inbound pitch with no known hiring company yet — combine with companyName for the human-readable label).`,
            "create_jobs:ambiguous:no_company",
          );
        }
      }

      let opportunityId: string | null = null;
      if (input.opportunity) {
        const r = opportunityBySlug.get(input.opportunity)!;
        if (!r.ok) return slugLookupError(r, { itemPrefix: `item ${i}: ` });
        opportunityId = r.value.id;
      }

      if (input.sourceUrl) {
        const existing = existingJobByUrl.get(input.sourceUrl);
        if (existing) {
          return toolError(
            "STATE_CONFLICT",
            `item ${i}: a job with sourceUrl=${input.sourceUrl} already exists (slug=${existing.slug ?? existing.id}, title="${existing.title}"). Use update_job to modify it.`,
            "create_jobs:conflict:duplicate_source_url",
          );
        }
      }

      resolved.push({
        raw: input,
        companyId,
        companyName,
        companySlug,
        opportunityId,
      });
    }

    // The Job + JobInteraction + SURFACED create (one transaction) and the
    // post-commit slug mint live in the entity fn; the tool only resolved the
    // slugs + validated above.
    const items: CreateJobInput[] = resolved.map((r) => ({
      companyId: r.companyId,
      companyName: r.companyName,
      companySlug: r.companySlug,
      opportunityId: r.opportunityId,
      title: r.raw.title,
      sourceUrl: r.raw.sourceUrl,
      rawContent: r.raw.rawContent,
      location: r.raw.location,
      department: r.raw.department,
      compensation: r.raw.compensation,
      employmentType: r.raw.employmentType,
    }));
    const created = await createJobs({ userId: ctx.userId, items });

    const lines = created.map((s) => {
      const oppNote = s.isPitched ? ` (pitched lead role)` : "";
      return `- ${s.slug ?? s.jobId} "${s.title}" at ${s.companyLabel}${oppNote}`;
    });
    return {
      content: `created ${created.length} job${created.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    };
  },
};
