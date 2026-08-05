import "dotenv/config";
import { Prisma } from "../../src/generated/prisma/client";
import { prisma } from "../../src/server/db/prisma";
import { roleAttrColumns } from "../../src/server/entities/jobs/roleAttrs";
import { scrapeUrl } from "../../src/server/scrape";
import { closeHeadless } from "../../src/server/platform/browser/headless";
import { detectAts } from "../../src/server/scrape/ats";

// Re-scrape every ATS-backed company and refresh the scrape-derived metadata on
// EXISTING job rows (matched by sourceUrl): location, department, compensation,
// employmentType, attributes, rawContent. Does NOT create rows, touch
// JobInteractions, or bump lastSeenAt — it's a pure metadata correction for the
// parser fixes (Ashby field-name bug, Lever comp, the new attributes bag).
//
// SAFETY: dry-run by default — prints what WOULD change, writes nothing. Pass
// --apply to actually write. The DB this hits is whatever .env's DATABASE_URL
// points at (currently the Railway prod/staging DB).
//
//   pnpm tsx scripts/ats/backfill-attributes.ts            # dry run
//   pnpm tsx scripts/ats/backfill-attributes.ts --apply    # write

const APPLY = process.argv.includes("--apply");

function attrsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function main() {
  const companies = await prisma.company.findMany({
    where: { sourceUrl: { not: null } },
    select: { id: true, name: true, sourceUrl: true },
    orderBy: { name: "asc" },
  });

  // Only ATS-recognized URLs scrape; skip the rest quietly.
  const targets = companies.filter(
    (c) => c.sourceUrl && detectAts(c.sourceUrl),
  );
  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} — ${targets.length} ATS companies (of ${companies.length} with a sourceUrl)\n`,
  );

  let totalMatched = 0;
  let locChanged = 0;
  let compGained = 0;
  let attrsGained = 0;
  let rowsWritten = 0;
  const failures: string[] = [];

  for (const c of targets) {
    const r = await scrapeUrl(c.sourceUrl!);
    if (!r.ok) {
      failures.push(`${c.name}: ${r.error}`);
      console.log(`  ✗ ${c.name} — scrape failed: ${r.error}`);
      continue;
    }
    const urls = r.data.jobs.map((j) => j.sourceUrl).filter(Boolean);
    const existing = await prisma.job.findMany({
      where: { sourceUrl: { in: urls } },
      select: {
        id: true,
        sourceUrl: true,
        locationAndArrangement: true,
        compensation: true,
        attributes: true,
      },
    });
    const byUrl = new Map(existing.map((j) => [j.sourceUrl, j]));

    let cMatched = 0;
    let cLoc = 0;
    let cComp = 0;
    let cAttrs = 0;
    for (const job of r.data.jobs) {
      const cur = byUrl.get(job.sourceUrl);
      if (!cur) continue; // new posting — backfill only touches existing rows
      cMatched++;
      if ((cur.locationAndArrangement ?? null) !== (job.location ?? null))
        cLoc++;
      if (!cur.compensation && job.compensation) cComp++;
      if (!attrsEqual(cur.attributes, job.attributes ?? null) && job.attributes)
        cAttrs++;

      if (APPLY) {
        await prisma.job.updateMany({
          where: { sourceUrl: job.sourceUrl },
          data: {
            ...roleAttrColumns(job),
            attributes: job.attributes
              ? (job.attributes as Prisma.InputJsonValue)
              : Prisma.DbNull,
            rawContent: job.rawContent,
          },
        });
        rowsWritten++;
      }
    }
    totalMatched += cMatched;
    locChanged += cLoc;
    compGained += cComp;
    attrsGained += cAttrs;
    console.log(
      `  ✓ ${c.name.padEnd(26)} matched ${String(cMatched).padStart(4)}  loc→${String(cLoc).padStart(4)}  +comp ${String(cComp).padStart(4)}  +attrs ${String(cAttrs).padStart(4)}`,
    );
  }

  console.log(`\n=== ${APPLY ? "APPLIED" : "DRY RUN"} SUMMARY ===`);
  console.log(
    `companies scraped:      ${targets.length - failures.length}/${targets.length}`,
  );
  console.log(`existing rows matched:  ${totalMatched}`);
  console.log(`location would change:  ${locChanged}`);
  console.log(`compensation gained:    ${compGained}`);
  console.log(`attributes gained:      ${attrsGained}`);
  if (APPLY) console.log(`rows written:           ${rowsWritten}`);
  if (failures.length) {
    console.log(`\nscrape failures (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (!APPLY) console.log(`\nNo writes made. Re-run with --apply to commit.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  // The headless Chromium singleton keeps the event loop alive too.
  .finally(async () => {
    await closeHeadless();
    await prisma.$disconnect();
  });
