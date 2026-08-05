// Agent-facing CompanyInteraction vocabularies: the status-reason lists the
// product OFFERS (block is a curated subset of its DB enum; close and pause are
// the whole thing) and the statuses the correction tool will set. Domain product
// decisions about what Hank can pick — shared by close_company / pause_company /
// block_company / update_company_interaction. Human labels live in
// entities/companies/humanCompanyReasonLabels.ts; the clear-on-transition rule in
// companyStatusFields.ts. Mirrors entities/jobs/jobInteractionInputs.ts on the
// job side.

import { CompanyStatus } from "@/generated/prisma/client";

// CLOSED is reserved for genuine dead-ends — "no fit right now but plausible
// later" is caught_up_company, and "couldn't read the board" is block_company.
export const COMPANY_CLOSE_REASONS = [
  "NOT_A_MATCH",
  "LOCATION_MISMATCH",
  "OTHER",
] as const;

// Company "pause" reasons. Pausing is a user-driven "set this aside for now";
// a company waiting on an external signal but still worth scanning is
// caught_up_company, not paused.
export const COMPANY_PAUSE_REASONS = ["USER_PAUSED", "OTHER"] as const;

// Blocking means "couldn't read their board", so a board behind a login is
// CANNOT_SCRAPE with the detail in the note, and an ambiguous company NAME isn't
// a block at all — Hank should ask which company they mean. NO_OWN_BOARD earns
// its own value because it has a distinct downstream action: offer to track the
// parent. So AMBIGUOUS_NAME and AUTH_WALLED stay in the DB enum but aren't
// offered here.
export const COMPANY_BLOCK_REASONS = [
  "CANNOT_SCRAPE",
  "NO_OWN_BOARD",
  "OTHER",
] as const;

// Statuses `update_company_interaction` will set directly — the correction path
// for a company whose cached status is simply wrong. Unlike the job enum there
// are no retired tombstones here, so every value is offered. IN_FLIGHT /
// IN_PROCESS / CAUGHT_UP are the auto-derived engagement tail (engagement.ts):
// settable, but the next job event recomputes them, so a wrong tail status is
// usually a wrong JOB status underneath.
export const SETTABLE_COMPANY_STATUSES = Object.values(CompanyStatus) as [
  CompanyStatus,
  ...CompanyStatus[],
];

// Statuses `list_companies` will FILTER by. Same values as the settable list
// today, but a different question — nothing is excluded from a lookup, so a
// status that stopped being settable would still be listable. (On the job side
// the two already diverge: SETTABLE_JOB_STATUSES drops the retired values.)
export const ALL_COMPANY_STATUSES = Object.values(CompanyStatus) as [
  CompanyStatus,
  ...CompanyStatus[],
];
