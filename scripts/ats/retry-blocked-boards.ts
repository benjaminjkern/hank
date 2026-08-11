// Re-try the companies that are already set aside as unreadable.
//
// Widening what we can read only helps companies scraped AFTER the change —
// the ones that already hit the wall are sitting at BLOCKED / CANNOT_SCRAPE and
// nothing re-examines them on its own (there's no scheduler, and the walkthrough
// only re-hunts a company the user revives by hand). This is the one-shot pass
// that reaches them.
//
// Three populations, because "unreadable" has three shapes and they need
// different work:
//   - HAS a url a WIRED provider owns → nothing is missing; the block is
//     usually stale. Re-test it and revive. Free.
//   - HAS a url on file → the board is known, the READER was the missing piece.
//     Probe it (free), then recon it (--recon).
//   - NO url on file → the hunt itself gave up, before recon existed. Re-run the
//     hunt, which now escalates to recon on the careers page it got furthest
//     with. Costs an LLM call by construction, so it needs --recon too.
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
import { reviveCompany } from "../../src/server/entities/companies/resumeCompany";
import { runEnrichCompaniesCollect } from "../../src/server/procedures/registry/enrichCompanies";
import { testScrape } from "../../src/server/scrape";
import { detectAts } from "../../src/server/scrape/ats";
import { MIN_REAL_JOBS } from "../../src/server/scrape/ats/shared";
import { runReconBoard } from "../../src/server/procedures/registry/reconBoard";
import { probeGenericBoard } from "../../src/server/scrape/generic/genericProbe";

const APPLY = process.argv.includes("--apply");
const WITH_RECON = process.argv.includes("--recon");
const LIMIT =
  Number(process.argv[process.argv.indexOf("--limit") + 1] || "0") || 0;

type Outcome =
  | { kind: "wired"; jobs: number; provider: string }
  | { kind: "probe"; jobs: number; family: string; technique: string }
  | { kind: "recon"; jobs: number; note: string }
  | { kind: "rehunt"; sourceUrl: string }
  | { kind: "needs_browser"; note: string }
  | { kind: "miss"; detail: string }
  | { kind: "skipped"; why: string };

async function main() {
  // Both populations, in one pass. Which branch a company takes is decided per
  // row by whether it has a url — see the header.
  const blocked = await prisma.companyInteraction.findMany({
    where: {
      status: CompanyStatus.BLOCKED,
      blockReason: {
        in: [CompanyBlockReason.CANNOT_SCRAPE, CompanyBlockReason.AUTH_WALLED],
      },
    },
    orderBy: { company: { name: "asc" } },
    select: {
      userId: true,
      company: {
        select: { id: true, name: true, slug: true, sourceUrl: true },
      },
    },
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  });
  const urlless = blocked.filter((r) => !r.company.sourceUrl).length;

  console.log(
    `\n${blocked.length} blocked compan${blocked.length === 1 ? "y" : "ies"}` +
      ` (${blocked.length - urlless} with a URL on file, ${urlless} without)` +
      `\nmode: ${APPLY ? "APPLY (writes)" : "dry run"}${WITH_RECON ? " + recon" : " (probe only)"}\n`,
  );
  if (urlless > 0 && !WITH_RECON) {
    console.log(
      `NOTE: the ${urlless} without a URL need the hunt re-run, which costs an LLM call.\n` +
        `      Pass --recon to include them.\n`,
    );
  }

  let readable = 0;
  for (const row of blocked) {
    const { company, userId } = row;
    const url = company.sourceUrl;

    const outcome = await tryCompany({
      companyId: company.id,
      companyName: company.name,
      companySlug: company.slug,
      userId,
      url,
    });
    if (
      outcome.kind === "wired" ||
      outcome.kind === "probe" ||
      outcome.kind === "recon" ||
      outcome.kind === "rehunt"
    ) {
      readable++;
    }
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
  companySlug: string;
  userId: string;
  url: string | null;
}): Promise<Outcome> {
  // No board on file at all: the HUNT is what failed, so re-run it. It now
  // escalates to recon against the careers page it gets furthest with, which is
  // the only way this class of company is reachable — nothing downstream can
  // help a company that never got a sourceUrl.
  if (!args.url) return await rehunt(args);

  // A wired provider owns this URL, so a learned reader is not what's missing —
  // and probing it anyway would paper over the real problem with a worse
  // reader. Ask the provider instead. Most of these turn out to read fine
  // today: the block is left over from a transient failure and nothing since
  // has re-examined it, which is the cheapest fix available here.
  if (detectAts(args.url)) {
    const check = await testScrape(args.url);
    if (check.ok && check.jobCount >= MIN_REAL_JOBS) {
      if (APPLY) {
        await reviveCompany({
          userId: args.userId,
          companyId: args.companyId,
        });
      }
      return {
        kind: "wired",
        jobs: check.jobCount,
        provider: check.provider,
      };
    }
    // The provider is wired but the board genuinely doesn't answer — a moved
    // board needs a fresh hunt, everything else is a real provider-level
    // problem this script shouldn't paper over.
    if (/404|not found/i.test(check.ok ? "" : check.error)) {
      return await rehunt(args);
    }
    return {
      kind: "skipped",
      why: `wired provider, still failing: ${(check.ok ? "" : check.error).slice(0, 90)}`,
    };
  }

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

// Re-run the URL hunt for a company that never got a board. `force` because
// basicInfoHuntedAt is already stamped from the failed hunt — without it the
// chain would skip straight past.
async function rehunt(args: {
  companyId: string;
  companyName: string;
  companySlug: string;
  userId: string;
}): Promise<Outcome> {
  if (!WITH_RECON) {
    return {
      kind: "skipped",
      why: "no URL on file — needs --recon to re-hunt",
    };
  }
  if (!APPLY) {
    return {
      kind: "skipped",
      why: "no URL on file — re-hunt writes, so it needs --apply",
    };
  }

  const session = await prisma.chatSession.findFirst({
    where: { userId: args.userId, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!session) return { kind: "skipped", why: "no active ChatSession" };

  const result = await runEnrichCompaniesCollect({
    userId: args.userId,
    sessionId: session.id,
    force: true,
    companies: [
      {
        companyId: args.companyId,
        slug: args.companySlug,
        name: args.companyName,
      },
    ],
  });

  const outcome = result.results[0]?.outcome;
  if (outcome?.kind === "enriched" && outcome.sourceUrl) {
    // The hunt (or the recon behind it) landed a board. Clear the set-aside —
    // leaving it BLOCKED with a working URL would be a lie the user has to
    // undo by hand.
    await reviveCompany({ userId: args.userId, companyId: args.companyId });
    return { kind: "rehunt", sourceUrl: outcome.sourceUrl };
  }
  return {
    kind: "miss",
    detail:
      outcome?.kind === "cannot_scrape"
        ? outcome.reason
        : `re-hunt returned ${outcome?.kind ?? "nothing"}`,
  };
}

function describe(o: Outcome): string {
  switch (o.kind) {
    case "wired":
      return `READABLE (${o.provider}) — ${o.jobs} jobs; the block was stale, company revived`;
    case "probe":
      return `READABLE (probe) — ${o.jobs} jobs via ${o.technique} [${o.family}]`;
    case "recon":
      return `READABLE (recon) — ${o.jobs} jobs. ${o.note}`;
    case "rehunt":
      return `READABLE (re-hunt) — board found at ${o.sourceUrl}; company revived`;
    case "needs_browser":
      return `needs a browser — ${o.note}`;
    case "miss":
      return `still unreadable — ${o.detail}`;
    case "skipped":
      return `skipped — ${o.why}`;
  }
}

void main();
