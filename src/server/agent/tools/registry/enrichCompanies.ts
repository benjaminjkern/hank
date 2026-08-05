// enrich_companies — work out who a company is: careers/ATS URL, canonical
// name, description, verified logo. Two shapes, one chain:
//   - no `companies` → every NEW stub the user just added, gaps only. Ends by
//     showing the what's-next picker, because "I'm done adding" is the only
//     reason to call it this way.
//   - `companies: [...]` → just those, and `force` re-runs the lookup from
//     scratch when the details on file look wrong. No picker: the user asked to
//     fix a company, not to be asked what's next.
//
// It does NOT pull in roles — that's scrape_jobs_for_company, or the walkthrough
// on entry.

import { z } from "zod";

import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { resolveCompaniesBySlug } from "@/server/entities/resolveBySlug";
import {
  runEnrichCompaniesCollect,
  type CompanyEnrichResult,
  type CompanyToEnrich,
} from "@/server/procedures/registry/enrichCompanies";
import { runWhatsNext } from "@/server/procedures/registry/whatsNext";

import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

const PARSER = z.object({
  companies: z.array(z.string().min(1)).optional(),
  force: z.boolean().optional(),
});

// Agent-facing, so it names what happened rather than how it read.
function lineFor(result: CompanyEnrichResult): string {
  switch (result.outcome.kind) {
    case "enriched": {
      const did = [
        result.outcome.hunted ? "looked up its careers page" : null,
        result.outcome.logoVerified ? "checked its logo" : null,
      ].filter(Boolean);
      const attached = result.outcome.attachedToExisting
        ? " (merged into the company already on file with that board)"
        : "";
      return `- ${result.name}: ${did.join(" and ")}${attached}`;
    }
    case "already_enriched":
      return `- ${result.name}: already up to date`;
    case "cannot_scrape":
      return `- ${result.name}: no readable job board found — set aside as blocked, revivable if the user supplies a URL`;
    case "ambiguous":
      return `- ${result.name}: the name matches more than one real company (${result.outcome.candidates.map((c) => c.canonicalName).join(" / ")}) — left as-is; ask the user which they meant`;
    case "hunter_failed":
      return `- ${result.name}: lookup failed this time (${result.outcome.error}) — still on the list, safe to retry`;
    case "not_found":
      return `- ${result.name}: no longer on the watchlist`;
  }
}

export const enrichCompaniesTool: ToolDef<z.infer<typeof PARSER>> = {
  name: "enrich_companies",
  affectsViewedState: true,
  description:
    "Look up who a company is: its careers/ATS page, canonical name, one-line description, and logo. Call with NO arguments when the user is done adding companies (e.g. they clicked \"no\" on the add-more widget, or said they're finished) — it looks up every newly-added company and then shows the \"what next?\" picker. Call with `companies` (slugs) to look up specific ones, plus `force: true` to redo it from scratch when a company's details look wrong (wrong careers page, garbled name, wrong logo). Safe to call when there's nothing to look up. This reads live careers pages a few at a time (~5-30s each), so BEFORE calling, narrate what's happening in plain English so the wait makes sense. NOTE: this does not pull in open roles — roles come in when the user walks the company, or via scrape_jobs_for_company.",
  inputSchema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: { type: "string" },
        description:
          "Company slugs (e.g. ['stripe']). Omit to look up every newly-added company.",
      },
      force: {
        type: "boolean",
        description:
          "Redo the lookup even if it's already been done. Use when the details on file look wrong.",
      },
    },
  },
  parser: PARSER,
  async handle(input, ctx) {
    const targeted = input.companies && input.companies.length > 0;

    let companies: CompanyToEnrich[];
    if (targeted) {
      const resolved: CompanyToEnrich[] = [];
      // One query for the whole list, not one per company.
      const lookups = await resolveCompaniesBySlug(
        ctx.userId,
        input.companies!,
      );
      for (const r of lookups.values()) {
        if (!r.ok) return slugLookupError(r);
        resolved.push({
          companyId: r.value.id,
          slug: r.value.slug,
          name: r.value.name,
        });
      }
      companies = resolved;
    } else {
      // Every NEW company — including ones that already have a sourceUrl
      // globally (a popular company another user mapped). The chain no-ops on
      // those, which is the point of the flags.
      const news = await prisma.companyInteraction.findMany({
        where: { userId: ctx.userId, status: CompanyStatus.NEW },
        select: { company: { select: { id: true, name: true, slug: true } } },
      });
      companies = news.map((n) => ({
        companyId: n.company.id,
        slug: n.company.slug,
        name: n.company.name,
      }));
    }

    const { results } = await runEnrichCompaniesCollect({
      ...ctx,
      companies,
      force: input.force,
    });

    const head = companies.length
      ? `looked up ${results.length} compan${results.length === 1 ? "y" : "ies"}:\n${results.map(lineFor).join("\n")}`
      : `nothing new to look up — every company on the watchlist already has its details.`;

    if (targeted) return { content: head };

    // Hand off to the walkthrough: surface the next-company picker now that the
    // companies have their details. Roles get pulled in when one is walked.
    const next = await runWhatsNext(ctx);
    const widgets =
      next.kind === "pick"
        ? [
            {
              kind: "next_company_picker",
              toolUseId: `enrich_companies_${crypto.randomUUID()}`,
              payload: {
                immediate: next.options.immediate,
                deferred: next.options.deferred,
                backlog: next.options.backlog,
                empty: next.empty,
              },
            },
          ]
        : undefined;

    return {
      content: `${head}\n\nThe "what next?" picker is showing — the user can pick a company to walk through, which is when its open roles get pulled in.`,
      widgets,
    };
  },
};
