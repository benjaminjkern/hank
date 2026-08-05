import {
  CompanyStatus,
  type Prisma,
  type CompanyBlockReason,
  type CompanyCloseReason,
  type CompanyPauseReason,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

import { companyStatusFields } from "./companyStatusFields";

type CompanyInteractionUpdates = {
  // Set the cached status directly, WITHOUT a backing CompanyEvent — this is the
  // correction path ("they're not closed, they're just on hold"), not the
  // something-happened path (close_company / pause_company / block_company /
  // caught_up_company, which write the feed row and let it carry the reason).
  // Passing it applies the clear-on-transition rule below.
  status?: CompanyStatus;
  closeReason?: CompanyCloseReason | null;
  closeNote?: string | null;
  pauseReason?: CompanyPauseReason | null;
  pauseNote?: string | null;
  blockReason?: CompanyBlockReason | null;
  blockNote?: string | null;
};

// Clear-on-transition, via the single source of truth: a status write sets ALL
// six reason/note columns — the new status's pair from the caller, the other
// four to null — so a status chain never strands a stale closeReason /
// pauseReason / blockReason. Branching on the literal narrows to the right
// companyStatusFields variant. Consequence worth knowing: re-stating the same
// status without its note WIPES the old note, exactly as close_company does.
function statusFieldsFor(
  status: CompanyStatus,
  updates: CompanyInteractionUpdates,
) {
  switch (status) {
    case CompanyStatus.CLOSED:
      return companyStatusFields({
        status,
        closeReason: updates.closeReason,
        closeNote: updates.closeNote,
      });
    case CompanyStatus.PAUSED:
      return companyStatusFields({
        status,
        pauseReason: updates.pauseReason,
        pauseNote: updates.pauseNote,
      });
    case CompanyStatus.BLOCKED:
      return companyStatusFields({
        status,
        blockReason: updates.blockReason,
        blockNote: updates.blockNote,
      });
    default:
      return companyStatusFields({ status });
  }
}

// Shared partial-update for one user's CompanyInteraction (the watchlist row) —
// the company-side twin of entities/jobs/updateJobInteraction. `update`, not
// `upsert`: correcting a record must never quietly ADD a company to the
// watchlist (that's create_companies / enrich_companies), so the caller checks
// membership first and a missing row throws P2025 on the race. Returns the list
// of field names that were applied (for the tool's result string).
export async function updateCompanyInteraction(
  userId: string,
  companyId: string,
  updates: CompanyInteractionUpdates,
): Promise<string[]> {
  const data: Prisma.CompanyInteractionUncheckedUpdateInput = {};
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.closeReason !== undefined) data.closeReason = updates.closeReason;
  if (updates.closeNote !== undefined) data.closeNote = updates.closeNote;
  if (updates.pauseReason !== undefined) data.pauseReason = updates.pauseReason;
  if (updates.pauseNote !== undefined) data.pauseNote = updates.pauseNote;
  if (updates.blockReason !== undefined) data.blockReason = updates.blockReason;
  if (updates.blockNote !== undefined) data.blockNote = updates.blockNote;

  // Snapshot the caller's fields BEFORE clear-on-transition, so the returned
  // list is what was asked for — the nulls the rule adds below are bookkeeping,
  // not an update the agent requested, and echoing them back reads as "I also
  // wiped your close reason" on an unrelated status fix.
  const keys = Object.keys(data);
  if (keys.length === 0) return [];

  if (updates.status !== undefined) {
    Object.assign(data, statusFieldsFor(updates.status, updates));
  }

  await prisma.companyInteraction.update({
    where: { userId_companyId: { userId, companyId } },
    data,
  });

  return keys;
}
