import { z } from "zod";

import { updateCompanyFields } from "@/server/entities/companies/updateCompany";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";
import { normalizeUrlInput } from "@/utils/url";

import { slugLookupError } from "../lib/slugLookupError";
import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const updateCompanyTool: ToolDef<{
  company: string;
  url?: string;
  name?: string;
  logoUrl?: string | null;
  description?: string | null;
}> = {
  name: "update_company",
  affectsViewedState: true,
  description:
    'Update a Company-table field on a watchlisted company (identified by its slug). Pass any subset of: url (careers URL), name (canonical brand name), logoUrl (image URL override), description (one-line factual blurb shown in the company panel header). At least one must be present.\n\n- url: new careers URL (e.g. fixing a bespoke /careers → direct ATS URL like jobs.ashbyhq.com/<slug>). Re-derives the greenhouseSlug if it parses as a Greenhouse URL.\n- name: canonical brand name. Fix when the existing watchlist entry is clearly slug-derived ("Findarbor", "Cognition-Ai", missing capitalization). Changing the name re-derives the memory-note slug too — don\'t churn casually.\n- logoUrl: explicit logo URL override. Use when the user reports a wrong company image (auto-derivation guesses `{ats-slug}.com`\'s favicon which fails for Cognition Labs on Ashby slug "cognition", etc.). Pass a direct image URL or `https://www.google.com/s2/favicons?domain=<real-domain>&sz=128`. Pass `null` to clear the override and fall back to the auto-derived URL.\n- description: short factual one-liner ("Series B data infra company; ETL pipelines for analytics teams"). Use for the company panel header. Longer narrative notes still go to companies/{slug}.md via write_memory.',
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description: "Company slug (e.g. 'stripe').",
      },
      url: { type: "string", description: "Optional new careers URL." },
      name: { type: "string", description: "Optional new canonical name." },
      logoUrl: {
        type: ["string", "null"],
        description:
          "Optional logo URL override. Pass null to clear and fall back to the auto-derived URL.",
      },
      description: {
        type: ["string", "null"],
        description:
          "Optional short factual one-liner rendered in the company panel header. Pass null to clear.",
      },
    },
    required: ["company"],
  },
  parser: z
    .object({
      company: z.string(),
      url: z
        .string()
        .transform(normalizeUrlInput)
        .pipe(z.string().url())
        .optional(),
      name: z.string().optional(),
      logoUrl: z
        .string()
        .transform(normalizeUrlInput)
        .pipe(z.string().url())
        .nullable()
        .optional(),
      description: z.string().nullable().optional(),
    })
    .refine(
      (v) =>
        v.url !== undefined ||
        v.name !== undefined ||
        v.logoUrl !== undefined ||
        v.description !== undefined,
      {
        message:
          "at least one of url, name, logoUrl, or description is required",
      },
    ),
  async handle({ company: companySlug, url, name, logoUrl, description }, ctx) {
    const companyResolved = await resolveCompanyBySlug(ctx.userId, companySlug);
    if (!companyResolved.ok) {
      return slugLookupError(companyResolved, { source: "update_company" });
    }
    // The slug/greenhouseSlug re-derivation + field write is the entity fn's job;
    // the tool resolves the slug and formats the change summary.
    const result = await updateCompanyFields({
      companyId: companyResolved.value.id,
      patch: { url, name, logoUrl, description },
    });
    if (!result.ok) {
      return toolError(
        "ENTITY_NOT_FOUND",
        `no company found for "${companySlug}".`,
        "update_company:not_found:company",
      );
    }
    const finalName = result.finalName;

    const changes: string[] = [];
    if (url !== undefined) changes.push(`url → ${url}`);
    if (name !== undefined) changes.push(`name → ${finalName}`);
    if (logoUrl !== undefined)
      changes.push(
        logoUrl === null ? "logoUrl cleared" : `logoUrl → ${logoUrl}`,
      );
    if (description !== undefined)
      changes.push(
        description === null
          ? "description cleared"
          : `description → "${description}"`,
      );
    return { content: `updated ${finalName}: ${changes.join(", ")}` };
  },
};
