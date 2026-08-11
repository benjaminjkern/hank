// Re-try the companies that are already set aside as unreadable.
//
// Widening what we can read only helps companies scraped AFTER the change —
// the ones that already hit the wall are sitting at BLOCKED / CANNOT_SCRAPE and
// nothing re-examines them on its own (there's no scheduler, and the walkthrough
// only re-hunts a company the user revives by hand). This is the one-shot pass
// that reaches them.
//
// Two tiers, cheapest first, per company:
//   1. the deterministic probe — free, no LLM
//   2. recon — an LLM call, only on a probe miss, only with --recon
//
// HITS PROD. Dry-run by default; --apply is what writes. Read the plan it
// prints before you pass it.
//
//   pnpm tsx scripts/ats/retry-blocked-boards.ts                # dry run, probe only
//   pnpm tsx scripts/ats/retry-blocked-boards.ts --recon        # dry run, probe + recon
//   pnpm tsx scripts/ats/retry-blocked-boards.ts --recon --apply
//   pnpm tsx scripts/ats/retry-blocked-boards.ts --limit 5 --apply

import "dotenv/config";

import {
  BoardReaderOrigin,
  CompanyBlockReason,
  CompanyStatus,
} from "../../src/generated/prisma/client";
import { prisma } from "../../src/server/db/prisma";
import { saveBoardReader } from "../../src/server/entities/boardReaders/recordReaderRun";
import { runReconBoard } from "../../src/server/procedures/registry/reconBoard";
import { probeGenericBoard } from "../../src/server/scrape/generic/genericProbe";

const APPLY = process.argv.includes("--apply");
const WITH_RECON = process.argv.includes("--recon");
const LIMIT =
  Number(process.argv[process.argv.indexOf("--limit") + 1] || "0") || 0;

type Outcome =
  | { kind: "probe"; jobs: number; family: string; technique: string }
  | { kind: "recon"; jobs: number; note: string }
  | { kind: "needs_browser"; note: string }
  | { kind: "miss"; detail: string }
  | { kind: "skipped"; why: string };

async function main() {
  // Only companies with a URL on file: those are the ones where a better READER
  // is the missing piece. A company with no URL at all needs the hunter re-run
  // (enrich_companies with force), which is a different operation.
  const blocked = await prisma.companyInteraction.findMany({
    where: {
      status: CompanyStatus.BLOCKED,
      blockReason: {
        in: [CompanyBlockReason.CANNOT_SCRAPE, CompanyBlockReason.AUTH_WALLED],
      },
      company: { sourceUrl: { not: null } },
    },
    select: {
      userId: true,
      blockNote: true,
      company: { select: { id: true, name: true, sourceUrl: true } },
    },
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  });

  console.log(
    `\n${blocked.length} blocked compan${blocked.length === 1 ? "y" : "ies"} with a URL on file` +
      `\nmode: ${APPLY ? "APPLY (writes)" : "dry run"}${WITH_RECON ? " + recon" : " (probe only)"}\n`,
  );

  let readable = 0;
  for (const row of blocked) {
    const { company, userId } = row;
    const url = company.sourceUrl;
    if (!url) continue;

    const outcome = await tryCompany({
      companyId: company.id,
      companyName: company.name,
      userId,
      url,
    });
    if (outcome.kind === "probe" || outcome.kind === "recon") readable++;
    console.log(`${company.name.padEnd(28)} ${describe(outcome)}`);
  }

  console.log(
    `\n${readable}/${blocked.length} now readable.` +
      (APPLY
        ? " Readers saved; the companies stay BLOCKED until someone revives them — reviving now re-scrapes through the new reader.\n"
        : " Nothing written. Re-run with --apply to save the readers.\n"),
  );
  await prisma.$disconnect();
}

async function tryCompany(args: {
  companyId: string;
  companyName: string;
  userId: string;
  url: string;
}): Promise<Outcome> {
  const probed = await probeGenericBoard(args.url);
  if (probed.ok) {
    if (APPLY) {
      await saveBoardReader({
        companyId: args.companyId,
        sourceUrl: args.url,
        recipe: probed.recipe,
        origin: BoardReaderOrigin.PROBE,
      });
    }
    return {
      kind: "probe",
      jobs: probed.data.jobs.length,
      family: probed.recipe.familyKey ?? "-",
      technique: probed.technique,
    };
  }

  if (!WITH_RECON) {
    return { kind: "miss", detail: probed.tried.join(" | ") };
  }
  // Recon WRITES its verdict row (that's how the cooldown works), so it only
  // runs under --apply. A dry run reports what it would have cost instead.
  if (!APPLY) {
    return {
      kind: "skipped",
      why: "recon needs --apply (it persists a verdict)",
    };
  }

  const recon = await runReconBoard({
    userId: args.userId,
    companyId: args.companyId,
    companyName: args.companyName,
    sourceUrl: args.url,
    probeTried: probed.tried,
    // The operator asked for this pass explicitly; the cooldown exists to stop
    // automatic re-attempts, not deliberate ones.
    force: true,
  });
  switch (recon.kind) {
    case "learned":
      return { kind: "recon", jobs: recon.jobCount, note: recon.note };
    case "needs_browser":
      return { kind: "needs_browser", note: recon.note };
    case "needs_auth":
    case "exhausted":
      return { kind: "miss", detail: recon.note };
    case "skipped":
      return { kind: "skipped", why: recon.why };
  }
}

function describe(o: Outcome): string {
  switch (o.kind) {
    case "probe":
      return `READABLE (probe) — ${o.jobs} jobs via ${o.technique} [${o.family}]`;
    case "recon":
      return `READABLE (recon) — ${o.jobs} jobs. ${o.note}`;
    case "needs_browser":
      return `needs a browser — ${o.note}`;
    case "miss":
      return `still unreadable — ${o.detail}`;
    case "skipped":
      return `skipped — ${o.why}`;
  }
}

void main();
