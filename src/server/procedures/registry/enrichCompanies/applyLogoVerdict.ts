// Persist the logo verifier's verdict onto the Company row — the write half of
// runLogoVerifier, same split as scanJob → applyScanMatch.
//
// Always stamps `logoVerifiedAt`: "verified" means we ran the check, not that
// the logo was wrong. A company with no candidate image to check still counts
// as verified (there's nothing more to learn; the UI falls back to the
// monogram), which is what keeps the enrichment primitive and the walkthrough's
// logo-fill from re-verifying it on every pass.

import { prisma } from "@/server/db/prisma";
import type { LogoVerifierResult } from "@/server/subagents/registry/logoVerifier";
import { nowDate } from "@/utils/now";

// `verdict` is null when the check never ran (no candidate URL, or the vision
// call threw) — the stamp still lands, the logo is left alone.
export async function applyLogoVerdict(args: {
  companyId: string;
  verdict: LogoVerifierResult | null;
}): Promise<{ committed: boolean }> {
  const replacement =
    args.verdict?.verdict === "wrong" && args.verdict.betterUrl
      ? args.verdict.betterUrl
      : null;

  await prisma.company.update({
    where: { id: args.companyId },
    data: {
      logoVerifiedAt: nowDate(),
      ...(replacement ? { logoUrl: replacement } : {}),
    },
  });

  return { committed: replacement !== null };
}
