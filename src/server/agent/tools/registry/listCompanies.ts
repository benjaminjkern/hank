import { z } from "zod";

import { CompanyStatus, type Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { companyInitials } from "@/server/entities/companies/companyInitials";
import { ALL_COMPANY_STATUSES } from "@/server/entities/companies/companyInteractionInputs";
import { relativeAge } from "@/utils/date";
import { looksLikeAcronym } from "@/utils/text";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";

import type { ToolDef } from "../lib/types";

export const listCompaniesTool: ToolDef<{
  name?: string | string[];
  status?: CompanyStatus[];
  page?: number;
}> = {
  name: "list_companies",
  description:
    "List the companies the user has on their watchlist, each with its current status. By DEFAULT returns EVERY company the user has an interaction with — CLOSED + BLOCKED included — so a name lookup never misses one; use this to check 'is X on my list?' before telling the user it isn't. Optional filters: `name` (case-insensitive substring on the company name, OR an ARRAY of names to match ANY of them in one call — pass [\"Stripe\",\"Apple\",\"Sigma\"] when the user mentions several companies at once instead of calling the tool once per company; also matches by initials so 'AWS' finds 'Amazon Web Services'), `status` (array of CompanyStatus values to NARROW to — e.g. status:[\"BLOCKED\"] for the companies whose careers page couldn't be read, status:[\"CAUGHT_UP\"] for ones being watched). Results are paginated, 30 per page, most-recently-discussed first; pass `page` (1-indexed) for more. For CAUGHT_UP rows the last-scan age is included so you can judge if it's due for a fresh look; for CLOSED rows the closeReason and for BLOCKED rows the blockReason is included — both mean the company IS on the list, so offer to revive (CLOSED) or re-check (BLOCKED via company_walkthrough) rather than re-adding it. Use for 'what's on my list?' / 'is Reddit on my list?' / 'check Stripe, Apple and Google' / 'show me the closed ones' / 'the ones that couldn't load'.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1 },
        ],
        description:
          "Optional case-insensitive substring filter on the company name. Pass a single string, OR an array of strings to match ANY of them (OR search) — use the array form when the user names several companies at once so you make ONE call, not one per company. Also matches by initials ('AWS' → 'Amazon Web Services').",
      },
      status: {
        type: "array",
        items: {
          type: "string",
          enum: ALL_COMPANY_STATUSES as readonly string[] as string[],
        },
        description:
          'Optional array of CompanyStatus values to NARROW the results to. Omit to include every status (the default). status:["BLOCKED"] = the ones whose board couldn\'t be read; status:["CLOSED"] = the closed ones.',
      },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 companies per page, ordered most-recently-discussed first. If the company you're after isn't on the current page and the footer says more pages exist, request the next page.",
      },
    },
  },
  parser: z.object({
    name: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.array(z.enum(ALL_COMPANY_STATUSES)).optional(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ name, status, page }, ctx) {
    // Normalize name to a list of non-empty terms. Multiple terms match ANY
    // (OR) — so "check Stripe, Apple and Google" is one call, not three.
    const nameTerms = (Array.isArray(name) ? name : name ? [name] : [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const where: Prisma.CompanyInteractionWhereInput = {
      userId: ctx.userId,
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(nameTerms.length > 0
        ? {
            company: {
              OR: nameTerms.map((t) => ({
                name: { contains: t, mode: "insensitive" as const },
              })),
            },
          }
        : {}),
    };
    // Nothing is filtered out by default — every company the user has a
    // CompanyInteraction with is listable (CLOSED / BLOCKED included), so a
    // name lookup never misses a closed/skipped row.
    const p = await paginate(page, {
      count: () => prisma.companyInteraction.count({ where }),
      rows: ({ skip, take }) =>
        prisma.companyInteraction.findMany({
          where,
          include: {
            company: {
              select: { id: true, name: true, slug: true, sourceUrl: true },
            },
          },
          // Stable order so paging forward doesn't skip/repeat rows: stalest-
          // discussed first tiebroken by name.
          orderBy: [
            { lastDiscussedAt: { sort: "desc", nulls: "last" } },
            { company: { name: "asc" } },
          ],
          skip,
          take,
        }),
    });
    const { rows, total } = p;

    // Acronym matches (only for terms that look like an acronym). Computed
    // up-front so they surface even when the substring filter found nothing.
    let acronymNote = "";
    const acronymTerms = nameTerms.filter(looksLikeAcronym);
    if (acronymTerms.length > 0) {
      const targets = new Set(acronymTerms.map((t) => t.toUpperCase()));
      const lowerTerms = nameTerms.map((t) => t.toLowerCase());
      const candidates = await prisma.companyInteraction.findMany({
        where: { userId: ctx.userId },
        include: { company: { select: { id: true, name: true, slug: true } } },
        take: 500,
      });
      const hits = candidates.filter(
        (c) =>
          targets.has(companyInitials(c.company.name)) &&
          // Skip ones a substring search would already show (avoid double-listing).
          !lowerTerms.some((t) => c.company.name.toLowerCase().includes(t)),
      );
      if (hits.length > 0) {
        const hitLines = hits
          .map((h) => `${h.status}\t${h.company.name}\t(${h.company.slug})`)
          .join("\n");
        acronymNote = `\n\nLikely match${hits.length === 1 ? "" : "es"} by initials (already on the watchlist — do NOT create a duplicate; this is probably what the user means):\n${hitLines}`;
      }
    }

    if (total === 0) {
      const filterDesc = [
        nameTerms.length > 0 ? `name~[${nameTerms.join(", ")}]` : null,
        status && status.length > 0 ? `status in [${status.join(", ")}]` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const base = filterDesc
        ? `(no companies match ${filterDesc})`
        : "(watchlist is empty)";
      return { content: base + acronymNote };
    }
    if (isPastLastPage(p)) {
      return { content: pastLastPageMessage(p, "companies") };
    }
    const now = new Date();
    const lines = rows.map((r) => {
      let statusCol: string = r.status;
      if (r.status === CompanyStatus.CLOSED && r.closeReason) {
        statusCol = `CLOSED:${r.closeReason}`;
      } else if (r.status === CompanyStatus.BLOCKED) {
        statusCol = r.blockReason ? `BLOCKED:${r.blockReason}` : "BLOCKED";
      } else if (r.status === CompanyStatus.CAUGHT_UP) {
        const ageHint = r.lastScrapedJobsAt
          ? `scraped ${relativeAge(r.lastScrapedJobsAt, now)} ago`
          : "never scraped";
        statusCol = `CAUGHT_UP (${ageHint})`;
      }
      const urlCol = r.company.sourceUrl ?? "(no URL yet)";
      return `${statusCol}\t${r.company.name}\t${urlCol}\t(${r.company.slug})`;
    });
    return {
      content: lines.join("\n") + pageFooter(p, "companies") + acronymNote,
    };
  },
};
