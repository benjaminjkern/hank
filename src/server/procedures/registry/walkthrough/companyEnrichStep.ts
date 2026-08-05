// Step 0a of runCompanyArm: make sure we know WHO this company is before doing
// anything with their board.
//
// The chain itself is shared (procedures/registry/enrichCompanies) and is a
// cheap Postgres round-trip once a company's flags are stamped, so this runs on
// every entry. What's local is the consequence: mid-walkthrough there is no
// picker to render, so an ambiguous name gets set aside with a note rather than
// handed back as candidates — the one outcome the chain deliberately leaves to
// its caller.

import { CompanyBlockReason } from "@/generated/prisma/client";
import { statusEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { blockCompany } from "@/server/entities/companies/setCompanyAside";
import { runEnrichCompaniesCollect } from "@/server/procedures/registry/enrichCompanies";
import { urlHost } from "@/utils/url";

import { narrateCompanyBlock } from "./narration";
import { yieldStateChange } from "./yieldStateChange";

import type { WalkthroughArgs } from "./types";

type EnrichStepResult =
  | { wrapped: true; endedCompanyId?: string }
  // `companyId` can DIFFER from the one passed in: if the hunted board URL
  // already belonged to another Company row, this user's watchlist entry was
  // re-pointed at it and the stub deleted. The arm must carry on with this id.
  | { wrapped: false; companyId: string };

export async function* runCompanyEnrichStep(
  companyId: string,
  args: WalkthroughArgs,
): AsyncGenerator<TurnEvent, EnrichStepResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, slug: true, basicInfoHuntedAt: true },
  });
  if (!company) {
    // Shouldn't happen — the picker only surfaces companies that exist.
    yield statusEvent(
      "Couldn't find that company on the watchlist — moving on.",
    );
    return { wrapped: true };
  }
  const displayName = company.name;

  // Only the hunt is slow enough to narrate; a logo-only backfill is silent.
  if (!company.basicInfoHuntedAt) {
    yield statusEvent(`Looking for ${displayName}'s careers page…`);
  }

  const { results } = await runEnrichCompaniesCollect({
    ...args,
    companies: [{ companyId, slug: company.slug, name: displayName }],
  });
  const result = results[0];
  if (!result) return { wrapped: false, companyId };

  const setAside = async function* (
    reason: CompanyBlockReason,
    note: string,
  ): AsyncGenerator<TurnEvent, EnrichStepResult> {
    await blockCompany({ userId: args.userId, companyId, reason, note });
    yield* yieldStateChange(
      narrateCompanyBlock({
        companyId,
        companyName: displayName,
        reason,
        note,
      }),
    );
    return { wrapped: true, endedCompanyId: companyId };
  };

  switch (result.outcome.kind) {
    case "not_found":
      yield statusEvent(
        "Couldn't find that company on the watchlist — moving on.",
      );
      return { wrapped: true };

    case "hunter_failed":
      // User-facing: keep it plain. The raw hunter error (ATS slugs, fetch_url,
      // 404s) is developer-speak. BLOCKED rather than closed — a revive
      // re-hunts, so "try again later" actually works.
      yield statusEvent(
        `I hit a snag looking up ${displayName}'s job page — I'll set it aside for now and you can try again later.`,
      );
      return yield* setAside(CompanyBlockReason.OTHER, result.outcome.error);

    case "cannot_scrape":
      // The chain already wrote BLOCKED/CANNOT_SCRAPE — narrate and wrap.
      // Truthful + friendly; never surface the raw reason.
      yield statusEvent(
        `Looks like I can't quite read ${displayName}'s job page — I'll set it aside for now.`,
      );
      yield* yieldStateChange(
        narrateCompanyBlock({
          companyId,
          companyName: displayName,
          reason: CompanyBlockReason.CANNOT_SCRAPE,
          note: result.outcome.reason,
        }),
      );
      return { wrapped: true, endedCompanyId: companyId };

    case "ambiguous": {
      // The name collides with ≥2 real companies. Guessing one is exactly the
      // bug this outcome prevents, and there's no picker mid-walkthrough — so
      // set it aside with a note naming the candidates. The user can re-add it
      // with a hint (or supply a URL) later.
      const candidates = result.outcome.candidates;
      const names = candidates.map((c) => c.canonicalName).join(" / ");
      yield statusEvent(
        `"${displayName}" matches more than one company (${names}) — I'll set it aside so you can tell me which one you meant.`,
      );
      return yield* setAside(
        CompanyBlockReason.AMBIGUOUS_NAME,
        `Ambiguous name — candidates: ${candidates
          .map((c) => `${c.canonicalName} (${c.sourceUrl})`)
          .join("; ")}`,
      );
    }

    case "enriched":
      if (result.outcome.hunted && result.outcome.sourceUrl) {
        yield statusEvent(
          `Found ${result.name}'s careers page at ${urlHost(result.outcome.sourceUrl) ?? result.outcome.sourceUrl}.`,
        );
      }
      return { wrapped: false, companyId: result.companyId };

    case "already_enriched":
      return { wrapped: false, companyId: result.companyId };
  }
}
