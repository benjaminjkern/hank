// Agent-facing JobInteraction vocabularies + input shapes: the offered reason
// lists (curated subsets of the DB enums), the loggable event types, and the
// short-answer schema. Domain product decisions about what Hank can pick/log —
// shared by the job tools. The event → status mapping is jobEventStatus.ts; the
// human labels are entities/jobs/humanJobReasonLabels.ts.

import { z } from "zod";

import {
  JobEventType,
  JobCloseReason,
  JobInteractionStatus,
} from "@/generated/prisma/client";

export const ShortAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

// Every close reason the correction path may set, including WITHDRAWN — which
// close_job doesn't offer because withdrawing is a post-apply move.
export const ALL_JOB_CLOSE_REASONS = Object.values(JobCloseReason) as [
  JobCloseReason,
  ...JobCloseReason[],
];

export const JOB_CLOSE_REASONS = [
  "NOT_A_MATCH",
  "LOCATION_MISMATCH",
  "USER_REJECTED",
  "OTHER",
] as const;

// Job "defer" reasons. DEFERRED means "could apply, just outranked for now" —
// the shortlist defer-the-rest default is OUTRANKED.
export const JOB_DEFER_REASONS = ["OUTRANKED", "OTHER"] as const;

// Statuses `update_job_interaction` will set directly — the correction path for
// a role whose cached status is simply wrong. DELISTED is offered because a user
// can tell Hank the posting came down, but it's normally system-set from a
// re-scrape.
export const SETTABLE_JOB_STATUSES = Object.values(JobInteractionStatus) as [
  JobInteractionStatus,
  ...JobInteractionStatus[],
];

// Some job events have a dedicated canonical/system path and are refused in
// log_job_events so two write paths can't drift:
//   * APPLIED    → mark_job_applied (also wipes untouched drafts + returns the
//                  next SHORTLISTED job at the same company).
//   * DEFERRED   → defer_job (carries the deferReason + clear-on-transition).
//   * DELISTED   → system-set on a verified-complete re-scrape (posting gone);
//                  the agent never logs it by hand.
const NON_LOGGABLE_JOB_EVENT_TYPES: JobEventType[] = [
  JobEventType.APPLIED,
  JobEventType.DEFERRED,
  JobEventType.DELISTED,
];
export const LOG_JOB_EVENT_TYPES = (
  Object.values(JobEventType) as JobEventType[]
).filter((t) => !NON_LOGGABLE_JOB_EVENT_TYPES.includes(t)) as [
  JobEventType,
  ...JobEventType[],
];
