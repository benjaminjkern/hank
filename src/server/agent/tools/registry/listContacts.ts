import { z } from "zod";

import { prisma } from "@/server/db/prisma";
import { resolveCompanyBySlug } from "@/server/entities/resolveBySlug";

import {
  paginate,
  isPastLastPage,
  pastLastPageMessage,
  pageFooter,
} from "../lib/paginate";
import { slugLookupError } from "../lib/slugLookupError";

import type { ToolDef } from "../lib/types";

export const listContactsTool: ToolDef<{ company?: string; page?: number }> = {
  name: "list_contacts",
  description:
    "List the user's contacts, most-recently-updated first. Pass a company slug to filter to in-house contacts at one company, or omit to list all (including agency-based external recruiters with no company). Results are paginated, 30 per page; pass `page` (1-indexed) for more. Each row shows the contact's slug.",
  inputSchema: {
    type: "object",
    properties: {
      company: {
        type: "string",
        description:
          "Optional filter (company slug) — only contacts in-house at that company. Excludes agency-based contacts (which have no company).",
      },
      page: {
        type: "number",
        description:
          "1-indexed page number (default 1). 30 contacts per page, ordered most-recently-updated first. If the footer says more pages exist, pass page:N+1 for the next.",
      },
    },
  },
  parser: z.object({
    company: z.string().optional(),
    page: z.number().int().positive().optional(),
  }),
  async handle({ company, page }, ctx) {
    let companyId: string | undefined;
    if (company) {
      const companyResolved = await resolveCompanyBySlug(ctx.userId, company);
      if (!companyResolved.ok) {
        return slugLookupError(companyResolved);
      }
      companyId = companyResolved.value.id;
    }
    const where = { userId: ctx.userId, ...(companyId ? { companyId } : {}) };
    const p = await paginate(page, {
      count: () => prisma.contact.count({ where }),
      rows: ({ skip, take }) =>
        prisma.contact.findMany({
          where,
          // Stable order so paging forward doesn't skip/repeat rows on equal
          // updatedAt: most-recently-updated first, tiebroken by id.
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          select: {
            id: true,
            slug: true,
            name: true,
            role: true,
            agency: true,
            company: { select: { slug: true } },
            email: true,
          },
          skip,
          take,
        }),
    });
    if (p.total === 0) return { content: "(no contacts)" };
    if (isPastLastPage(p)) {
      return { content: pastLastPageMessage(p, "contacts") };
    }
    const { rows } = p;
    const lines = rows.map((c) => {
      const parts = [c.name];
      if (c.role) parts.push(c.role);
      if (c.agency) parts.push(`@ ${c.agency}`);
      else if (c.company?.slug) parts.push(`(in-house at ${c.company.slug})`);
      if (c.email) parts.push(c.email);
      return `${c.slug ?? c.id}\t${parts.join(" · ")}`;
    });
    return { content: lines.join("\n") + pageFooter(p, "contacts") };
  },
};
