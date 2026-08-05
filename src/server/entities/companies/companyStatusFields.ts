// Single source of truth for the "clear-on-transition" rule: every write to a
// CompanyInteraction status must set ALL reason/note fields — populate the pair
// belonging to the new status and force the other two statuses' four fields to
// null — so a status chain never strands a stale closeReason / pauseReason /
// blockReason. Funnel EVERY company-status update through here rather than
// hand-nulling at the call site.
//
// The discriminated union makes "set a reason without its matching status" a
// compile error. Callers with a dynamic status branch on the literal first so
// each branch narrows to the right variant.

import {
  CompanyStatus,
  type CompanyCloseReason,
  type CompanyPauseReason,
  type CompanyBlockReason,
} from "@/generated/prisma/client";

type CompanyStatusFieldsInput =
  | {
      status: typeof CompanyStatus.CLOSED;
      closeReason?: CompanyCloseReason | null;
      closeNote?: string | null;
    }
  | {
      status: typeof CompanyStatus.PAUSED;
      pauseReason?: CompanyPauseReason | null;
      pauseNote?: string | null;
    }
  | {
      status: typeof CompanyStatus.BLOCKED;
      blockReason?: CompanyBlockReason | null;
      blockNote?: string | null;
    }
  | {
      status: Exclude<
        CompanyStatus,
        | typeof CompanyStatus.CLOSED
        | typeof CompanyStatus.PAUSED
        | typeof CompanyStatus.BLOCKED
      >;
    };

type CompanyStatusFields = {
  status: CompanyStatus;
  closeReason: CompanyCloseReason | null;
  closeNote: string | null;
  pauseReason: CompanyPauseReason | null;
  pauseNote: string | null;
  blockReason: CompanyBlockReason | null;
  blockNote: string | null;
};

export function companyStatusFields(
  input: CompanyStatusFieldsInput,
): CompanyStatusFields {
  const base: CompanyStatusFields = {
    status: input.status,
    closeReason: null,
    closeNote: null,
    pauseReason: null,
    pauseNote: null,
    blockReason: null,
    blockNote: null,
  };
  switch (input.status) {
    case CompanyStatus.CLOSED:
      return {
        ...base,
        closeReason: input.closeReason ?? null,
        closeNote: input.closeNote ?? null,
      };
    case CompanyStatus.PAUSED:
      return {
        ...base,
        pauseReason: input.pauseReason ?? null,
        pauseNote: input.pauseNote ?? null,
      };
    case CompanyStatus.BLOCKED:
      return {
        ...base,
        blockReason: input.blockReason ?? null,
        blockNote: input.blockNote ?? null,
      };
    default:
      return base;
  }
}
