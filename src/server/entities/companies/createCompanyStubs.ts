// Create Company + CompanyInteraction(NEW) stub rows for a batch of names, in
// one transaction. Dedupe is by exact slug (a slug collision reliably means we
// already have the row); a name that already maps to a watchlisted company for
// this user comes back `existed` and is left untouched. No URL hunt / scrape —
// enrichment (runEnrichCompanies) runs separately. Shared by the
// create_companies tool and the find_companies checklist add so both build stubs
// the same way. `slug` is returned so the enrich step can run without a re-lookup.

import { CompanyStatus } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { companySlug } from "./companySlug";

// `context` (a disambiguating hint / suggestion reasoning) and `candidateUrl`
// (a board URL discovery already found) are echoed back from the input item so
// the enrich step can forward them to the URL hunter without a name-keyed
// re-lookup — the canonical name can differ from the input name when a stub
// attaches to an existing Company.
export type CompanyStubOutcome =
  | {
      kind: "created";
      name: string;
      companyId: string;
      slug: string;
      context?: string;
      candidateUrl?: string;
    }
  | {
      kind: "attached";
      name: string;
      companyId: string;
      slug: string;
      context?: string;
      candidateUrl?: string;
    }
  | {
      kind: "existed";
      name: string;
      companyId: string;
      slug: string;
      status: CompanyStatus;
      context?: string;
      candidateUrl?: string;
    };

export async function createCompanyStubs(
  userId: string,
  items: Array<{ name: string; context?: string; candidateUrl?: string }>,
): Promise<CompanyStubOutcome[]> {
  // Slug is the identity key: a collision is a reliable signal we already have
  // the row. (Loose name matching would be nicer, but it isn't reliable.)
  const slugs = items.map(
    (item) => companySlug(item.name) || item.name.toLowerCase().slice(0, 64),
  );

  // Four statements for any number of stubs, not four per stub. The two reads
  // go together, then the two inserts — each stage's input is the previous
  // stage's output, which is the one thing that genuinely has to be sequential.
  const existingCompanies = await prisma.company.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, name: true, slug: true },
  });
  const companyBySlug = new Map(existingCompanies.map((c) => [c.slug, c]));

  // Companies are global, so a name we've never seen has to be created before
  // anything can attach a per-user interaction to it.
  const newSlugs = new Set(slugs.filter((s) => !companyBySlug.has(s)));
  if (newSlugs.size > 0) {
    const createdCompanies = await prisma.company.createManyAndReturn({
      data: [...newSlugs].map((slug) => ({
        name: items[slugs.indexOf(slug)].name,
        slug,
      })),
      select: { id: true, name: true, slug: true },
    });
    for (const c of createdCompanies) companyBySlug.set(c.slug, c);
  }

  const existingInteractions = await prisma.companyInteraction.findMany({
    where: {
      userId,
      companyId: { in: [...companyBySlug.values()].map((c) => c.id) },
    },
    select: { companyId: true, status: true },
  });
  const statusByCompanyId = new Map(
    existingInteractions.map((i) => [i.companyId, i.status]),
  );

  const out: CompanyStubOutcome[] = [];
  const toAttach = new Set<string>();
  items.forEach((item, i) => {
    const company = companyBySlug.get(slugs[i])!;
    const echo = {
      context: item.context?.trim() ? item.context.trim() : undefined,
      candidateUrl: item.candidateUrl?.trim()
        ? item.candidateUrl.trim()
        : undefined,
    };
    // `toAttach` also catches the same company named twice in ONE call: the
    // second mention is already spoken for, so it reports as existing rather
    // than claiming a second create.
    const existingStatus = toAttach.has(company.id)
      ? CompanyStatus.NEW
      : statusByCompanyId.get(company.id);
    if (existingStatus !== undefined) {
      out.push({
        kind: "existed",
        name: company.name,
        companyId: company.id,
        slug: company.slug,
        status: existingStatus,
        ...echo,
      });
      return;
    }
    toAttach.add(company.id);
    out.push({
      // "created" = the Company row is new too; "attached" = it already existed
      // globally and this user just started watching it.
      kind: newSlugs.has(slugs[i]) ? "created" : "attached",
      name: company.name,
      companyId: company.id,
      slug: company.slug,
      ...echo,
    });
  });

  if (toAttach.size > 0) {
    await prisma.companyInteraction.createMany({
      data: [...toAttach].map((companyId) => ({
        userId,
        companyId,
        status: CompanyStatus.NEW,
      })),
      skipDuplicates: true,
    });
  }

  return out;
}
