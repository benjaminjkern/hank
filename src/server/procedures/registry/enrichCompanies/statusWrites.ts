// The bookkeeping writes the enrich chain makes against a Company /
// CompanyInteraction. Kept together because each is a detail of the chain
// rather than a step of it.

import { CompanyStatus, CompanyBlockReason } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { companyStatusFields } from "@/server/entities/companies/companyStatusFields";
import { nowDate } from "@/utils/now";

// `huntingStartedAt` drives the "Scanning…" badge, so it brackets the whole
// chain rather than just the hunter — the logo pass is slow enough to look
// frozen without it. Stale (>2min) means the run crashed mid-flight.
export async function beginHunting(companyId: string): Promise<void> {
  try {
    await prisma.company.update({
      where: { id: companyId },
      data: { huntingStartedAt: nowDate() },
    });
  } catch {
    // Row may be gone; the chain reports not_found on its own read.
  }
}

export async function clearHunting(companyId: string): Promise<void> {
  try {
    await prisma.company.update({
      where: { id: companyId },
      data: { huntingStartedAt: null },
    });
  } catch {
    // Stub is deleted in the attached-to-existing path; non-fatal.
  }
}

export async function markCannotScrape(args: {
  companyId: string;
  userId: string;
  reason: string;
}): Promise<void> {
  // Couldn't read the board → BLOCKED (a technical set-aside), not CLOSED (a
  // judgment the company won't work out). Revive re-hunts, so this is recoverable.
  await prisma.companyInteraction.update({
    where: {
      userId_companyId: { userId: args.userId, companyId: args.companyId },
    },
    // Full clear-on-transition — never hand-null just closeReason/closeNote, or a
    // prior pauseReason strands on a re-blocked stub.
    data: companyStatusFields({
      status: CompanyStatus.BLOCKED,
      blockReason: CompanyBlockReason.CANNOT_SCRAPE,
      blockNote: args.reason,
    }),
  });
}

export async function attachToExistingCompany(args: {
  stubCompanyId: string;
  existingCompanyId: string;
  userId: string;
}): Promise<void> {
  // Delete the stub's CompanyInteraction (only the current user has one;
  // others are by definition on the existingCompany), then delete the stub
  // Company itself. CompanyInteraction cascades on Company delete.
  await prisma.company.delete({ where: { id: args.stubCompanyId } });
  await prisma.companyInteraction.upsert({
    where: {
      userId_companyId: {
        userId: args.userId,
        companyId: args.existingCompanyId,
      },
    },
    // Full clear-on-transition — never hand-null just closeReason/closeNote, or a
    // prior blockReason strands when re-attaching a BLOCKED company as NEW.
    update: companyStatusFields({ status: CompanyStatus.NEW }),
    create: {
      userId: args.userId,
      companyId: args.existingCompanyId,
      status: CompanyStatus.NEW,
    },
  });
}
