// Enrich ONE company — the unit the batch fans out over.
//
// "Enriched" is an IDENTITY fact and nothing more: who this company is
// (canonical name + description), where their board lives (sourceUrl), and
// whether the logo we'd render is really theirs. Both flags are global,
// user-independent Company columns, so a second user adding the same company
// reuses the work.
//
// This chain does NOT scrape, upsert jobs, prescan, or land a company status —
// pulling roles in is a separate step that runs AFTER a company is enriched
// (`scrape_jobs_for_company`, or the walkthrough on entry). Folding them
// together is what made five near-identical enrich paths drift apart.

import { companyLogoUrl } from "@/lib/companyLogo";
import type { RunContext } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { runReconBoard } from "@/server/procedures/registry/reconBoard";
import { runVerifyCompanyLogo } from "@/server/procedures/registry/verifyCompanyLogo";
import { runSubAgent } from "@/server/subagents/lib/runSubAgent";
import { companyBasicInfoSubAgent } from "@/server/subagents/registry/companyBasicInfo";
import type { LogoVerifierResult } from "@/server/subagents/registry/logoVerifier";

import { applyLogoVerdict } from "./applyLogoVerdict";
import { commitHuntedUrl } from "./commitHuntedUrl";
import { beginHunting, clearHunting, markCannotScrape } from "./statusWrites";

import type { CompanyEnrichResult, CompanyToEnrich } from "./types";

export type EnrichOneArgs = RunContext & {
  sessionId: string;
  force?: boolean;
};

export async function enrichOne(
  company: CompanyToEnrich,
  args: EnrichOneArgs,
): Promise<CompanyEnrichResult> {
  const row = await prisma.company.findUnique({
    where: { id: company.companyId },
    select: {
      name: true,
      slug: true,
      sourceUrl: true,
      logoUrl: true,
      basicInfoHuntedAt: true,
      logoVerifiedAt: true,
    },
  });
  if (!row) {
    return {
      companyId: company.companyId,
      name: company.name,
      outcome: { kind: "not_found" },
    };
  }

  // Nothing to do is the COMMON case: the walkthrough runs this on every
  // company-arm entry as a backfill, so an already-enriched company must cost
  // one read and zero writes — not a "Scanning…" badge that flickers on and off.
  const willHunt =
    Boolean(company.resolved) || args.force || !row.basicInfoHuntedAt;
  const willVerifyLogo = args.force || !row.logoVerifiedAt;
  if (!willHunt && !willVerifyLogo) {
    return {
      companyId: company.companyId,
      name: row.name,
      outcome: { kind: "already_enriched" },
    };
  }

  // Brackets the whole chain so the "Scanning…" badge covers the logo pass too.
  // Cleared against the id we STAMPED — on attach the stub is gone by then and
  // the clear no-ops, which is why it must not chase the new id.
  await beginHunting(company.companyId);
  try {
    return await runChain(company, row, args);
  } finally {
    await clearHunting(company.companyId);
  }
}

type CompanyRow = {
  name: string;
  slug: string;
  sourceUrl: string | null;
  logoUrl: string | null;
  basicInfoHuntedAt: Date | null;
  logoVerifiedAt: Date | null;
};

async function runChain(
  company: CompanyToEnrich,
  row: CompanyRow,
  args: EnrichOneArgs,
): Promise<CompanyEnrichResult> {
  let companyId = company.companyId;
  let name = row.name;
  let sourceUrl = row.sourceUrl;
  let logoUrl = row.logoUrl;
  let logoVerifiedAt = row.logoVerifiedAt;
  let attachedToExisting = false;
  let hunted = false;

  // ── Identity: adopt a picked URL, or hunt for one. ──
  // `force` short-circuits the flag rather than clearing it — the chain re-stamps
  // both flags on the way through, so nulling them first would only widen the
  // window where a concurrent reader sees an un-enriched company.
  const picked = company.resolved ?? null;
  if (picked || args.force || !row.basicInfoHuntedAt) {
    const huntResult = picked
      ? ({ ok: true, found: picked } as const)
      : await hunt(company, row, args);
    if (!huntResult.ok) return huntResult.result;

    const committed = await commitHuntedUrl({
      userId: args.userId,
      companyId,
      currentSlug: row.slug,
      found: huntResult.found,
    });
    companyId = committed.companyId;
    name = committed.canonicalName;
    sourceUrl = committed.sourceUrl;
    logoUrl = committed.logoUrl;
    logoVerifiedAt = committed.logoVerifiedAt;
    attachedToExisting = committed.attachedToExisting;
    hunted = true;
  }

  // ── Logo: is the mark we'd render actually theirs? ──
  // Errors are swallowed and the verdict is stamped either way: "verified" means
  // the check RAN, so a company with no derivable logo doesn't re-check forever.
  let logoVerified = false;
  if (args.force || !logoVerifiedAt) {
    const candidate = companyLogoUrl(sourceUrl, logoUrl);
    let verdict: LogoVerifierResult | null = null;
    if (candidate.length > 0) {
      try {
        verdict = await runVerifyCompanyLogo(
          { companyName: name, candidateLogoUrl: candidate, companyId },
          args,
        );
      } catch (err) {
        console.warn(`[enrichCompanies] logo verify failed for ${name}:`, err);
      }
    }
    await applyLogoVerdict({ companyId, verdict });
    logoVerified = true;
  }

  return {
    companyId,
    name,
    outcome:
      hunted || logoVerified
        ? {
            kind: "enriched",
            hunted,
            logoVerified,
            sourceUrl,
            attachedToExisting,
          }
        : { kind: "already_enriched" },
  };
}

type HuntFound = {
  canonicalName: string;
  sourceUrl: string;
  shortDescription: string;
  longNotes?: string | null;
};

// Run the URL hunter. Either yields the payload to commit, or ends the chain —
// the three non-found outcomes have nothing to commit and differ only in who
// cleans up after them.
async function hunt(
  company: CompanyToEnrich,
  row: CompanyRow,
  args: EnrichOneArgs,
): Promise<
  { ok: true; found: HuntFound } | { ok: false; result: CompanyEnrichResult }
> {
  const stop = (outcome: CompanyEnrichResult["outcome"]) =>
    ({
      ok: false,
      result: { companyId: company.companyId, name: row.name, outcome },
    }) as const;

  const hunter = await runSubAgent(
    companyBasicInfoSubAgent,
    {
      companyName: row.name,
      extraContext: company.context,
      candidateUrl: company.candidateUrl,
    },
    args,
  );

  // Transient (API error / timeout / turn exhaustion) — leave the row alone so a
  // retry is a retry, not a revive.
  if (!hunter.ok) return stop({ kind: "hunter_failed", error: hunter.error });

  if (hunter.output.outcome === "cannot_scrape") {
    const gaveUp = hunter.output;
    // Last chance before the company is set aside. This is the ONLY moment
    // recon can reach a company whose board nothing recognizes: giving up here
    // writes no sourceUrl, and every later escalation (the scrape paths, the
    // backfill script) is keyed on having one — so without this branch such a
    // company is BLOCKED permanently, unreachable by anything downstream.
    if (gaveUp.bestCandidateUrl) {
      const recon = await runReconBoard({
        ...args,
        companyId: company.companyId,
        companyName: gaveUp.canonicalName ?? row.name,
        sourceUrl: gaveUp.bestCandidateUrl,
      });
      if (recon.kind === "learned") {
        // Recon proved the board readable, so the page the hunter gave up on IS
        // this company's board — commit it exactly as a found one. The hunter's
        // own identity findings ride along; a blank description is honest when
        // it never worked out who they are, and enrichment can fill it later.
        return {
          ok: true,
          found: {
            sourceUrl: gaveUp.bestCandidateUrl,
            canonicalName: gaveUp.canonicalName ?? row.name,
            shortDescription: gaveUp.shortDescription ?? "",
            longNotes: gaveUp.longNotes,
          },
        };
      }
    }
    await markCannotScrape({
      companyId: company.companyId,
      userId: args.userId,
      reason: gaveUp.reason,
    });
    return stop({ kind: "cannot_scrape", reason: gaveUp.reason });
  }

  // Needs a human: guessing which of several real companies was meant is the
  // exact bug this outcome exists to prevent. No status write — the caller has
  // the context to know whether it can ask.
  if (hunter.output.outcome === "ambiguous") {
    return stop({ kind: "ambiguous", candidates: hunter.output.candidates });
  }

  return { ok: true, found: hunter.output };
}
