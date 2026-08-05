// Domain maps for the job-event → JobInteraction status relationship. These encode
// lifecycle truth (which event advances a role to which status, and which events
// also surface as a per-role company milestone), so they belong to the jobs
// entity layer, not to the tool layer that calls into it. The single applier is
// `logJobEvents`; the tool layer imports the agent-facing enum LISTS
// (LOG_JOB_EVENT_TYPES), but the *mapping* is domain.

import {
  type JobEventType,
  CompanyEventType,
  JobInteractionStatus,
} from "@/generated/prisma/client";

// The cached `JobInteraction.status` a given event advances the role to. The
// OpportunityEvent log is the audit trail; status is its denormalized read.
export const EVENT_TO_STATUS: Partial<
  Record<JobEventType, JobInteractionStatus>
> = {
  SHORTLISTED: JobInteractionStatus.SHORTLISTED,
  CLOSED: JobInteractionStatus.CLOSED,
  DEFERRED: JobInteractionStatus.DEFERRED,
  DELISTED: JobInteractionStatus.DELISTED,
  APPLIED: JobInteractionStatus.APPLIED,
  RESPONDED: JobInteractionStatus.RESPONDED,
  INTERVIEW_SCHEDULED: JobInteractionStatus.INTERVIEW_SCHEDULED,
  INTERVIEW_HAPPENED: JobInteractionStatus.INTERVIEW_DEBRIEF,
  AWAITING_RESPONSE: JobInteractionStatus.WAITING_ON_RESPONSE,
  OFFERED: JobInteractionStatus.OFFERED,
  REJECTED: JobInteractionStatus.REJECTED,
  WITHDRAWN: JobInteractionStatus.CLOSED,
};

// True when the role's cached status is the one this event type set — i.e.
// deleting that event would leave the denormalized status with no backing event.
// delete_job_event uses it to flag (not auto-recompute) a now-stale status.
export function statusBackedByEvent(
  status: JobInteractionStatus,
  eventType: JobEventType,
): boolean {
  const mapped = EVENT_TO_STATUS[eventType];
  return mapped != null && mapped === status;
}

// Job events that ALSO surface as a per-role company event (dual-write). These
// are the low-volume, high-signal role milestones — mechanical/batch events
// (SURFACED/SCANNED/CLOSED/SHORTLISTED) never dual-write; they collapse to one
// summary company event at their batch seam instead. The value is the parallel
// CompanyEventType.
export const DUAL_WRITE_COMPANY_EVENT: Partial<
  Record<JobEventType, CompanyEventType>
> = {
  APPLIED: CompanyEventType.APPLIED,
  RESPONDED: CompanyEventType.RESPONDED,
  INTERVIEW_SCHEDULED: CompanyEventType.INTERVIEW_SCHEDULED,
  INTERVIEW_HAPPENED: CompanyEventType.INTERVIEW_HAPPENED,
  OFFERED: CompanyEventType.OFFERED,
  REJECTED: CompanyEventType.REJECTED,
  WITHDRAWN: CompanyEventType.WITHDRAWN,
};
