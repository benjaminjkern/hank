import type {
  DashboardCompany,
  DashboardOpportunity,
} from "@/client/chatStore";
import { statusTone, type StatusTone } from "@/shared/statusColors";

// Triage buckets surfaced on the dashboard. The user reads top → bottom as
// "deal with this now → employer engaged → applied, waiting → can wait → just
// watching → paused → couldn't read → done". Bucket selection for a company
// maps its CompanyStatus (mostly auto-derived now) + any owed job status;
// bucketForCompany() below is the single decision point.
//
// "In process" (recruiter engaged / interview coming), "In flight" (key:
// awaitingReply — applied, waiting on the employer) and "Watching" (caught-up,
// no work) are three distinct company statuses now — each its own bucket.
export type Bucket =
  | "now"
  | "inProcess"
  | "next"
  | "awaitingReply"
  | "watching"
  | "paused"
  | "blocked"
  | "closed";

// Bucket → status-tone color. Drives both the small dot before the section
// title and the tinted hover background on the header. now=Hank purple,
// inProcess=Hank purple (promising), next=dark grey, awaitingReply("In
// flight")=green, watching=teal, paused=amber, blocked=slate, closed=red.
// See [src/shared/statusColors.ts] + [docs/lifecycle.md].
export const BUCKET_TONE: Record<Bucket, StatusTone> = {
  now: "focusNow",
  inProcess: "focusNow",
  next: "notStarted",
  awaitingReply: "resting",
  watching: "watching",
  paused: "deferred",
  blocked: "blocked",
  closed: "closed",
};

function userOwes(status: string): boolean {
  // Anything tagged focusNow (= mid-flight work the user actively drives)
  // bumps the company to Now. Currently: PITCHED, SCANNED, SHORTLISTED,
  // INTERVIEW_DEBRIEF, OFFERED.
  return statusTone(status) === "focusNow";
}

// Live buckets a company/opportunity can land in (the rest come pre-split from
// the server: paused / blocked / closed).
type LiveBucket = "now" | "inProcess" | "next" | "awaitingReply" | "watching";

function bucketForCompany(c: DashboardCompany): LiveBucket {
  // An owed job (interview debrief / offer) anywhere bubbles the company to Now,
  // regardless of its engagement status.
  if (c.jobInteractions.some((i) => userOwes(i.status))) return "now";
  // SHORTLISTING (board open, their marks owed) and APPLYING (working the
  // committed picks) are both live work → Now.
  if (c.status === "SHORTLISTING" || c.status === "APPLYING") return "now";
  // IN_PROCESS = an employer engaged (recruiter reply / interview) → its own
  // promising bucket.
  if (c.status === "IN_PROCESS") return "inProcess";
  // IN_FLIGHT = applications out, waiting to hear back → "In flight".
  if (c.status === "IN_FLIGHT") return "awaitingReply";
  // Defensive fallback: any live in-pipeline JobInteraction ⇒ ball's in their court
  // (covers legacy rows whose engagement status hasn't been re-derived).
  if (c.jobInteractions.length > 0) return "awaitingReply";
  // Truly idle / not-yet-started: NEW (no scan yet) and READY (scanned +
  // prescanned, walkthrough not started — also where a company sits while its
  // board is being read, since nothing is owed by the user yet).
  if (c.status === "NEW" || c.status === "READY") return "next";
  // CAUGHT_UP with nothing live: scanned, nothing actionable, just watching
  // for new postings — no work required.
  return "watching";
}

function bucketForOpportunity(o: DashboardOpportunity): LiveBucket {
  // OPEN (focusNow tone) = fresh lead, user owes triage. SCREENING + AWAITING
  // = waiting on the other side → "In flight" (the awaitingReply bucket).
  return statusTone(o.status) === "focusNow" ? "now" : "awaitingReply";
}

export const BUCKET_META: Record<Bucket, { label: string; hint: string }> = {
  now: { label: "Now", hint: "deal with these" },
  inProcess: {
    label: "In process",
    hint: "a recruiter's engaged — interview coming",
  },
  next: { label: "Not started", hint: "haven't gotten to these yet" },
  awaitingReply: {
    label: "In flight",
    hint: "applied — ball's in their court",
  },
  watching: {
    label: "Watching",
    hint: "no work right now — checking back for new roles",
  },
  paused: {
    label: "Paused",
    hint: "set aside for now — revive to pick back up",
  },
  blocked: {
    label: "Blocked",
    hint: "couldn't read the board — revive to re-check",
  },
  closed: { label: "Closed", hint: "closed out or done" },
};

// Default-open buckets. Now + In process are expanded by default (the live,
// promising work); the rest are collapsed so the dashboard reads as "here's
// what you should be doing right now", everything else one click away.
export const DEFAULT_OPEN: Record<Bucket, boolean> = {
  now: true,
  inProcess: true,
  next: false,
  awaitingReply: false,
  watching: false,
  paused: false,
  blocked: false,
  closed: false,
};

type LiveBucketContents = {
  companies: DashboardCompany[];
  opportunities: DashboardOpportunity[];
};

// Bucket the live items into the "still in motion" buckets. Each carries both
// companies and opportunities so the user sees one cohesive triage list per
// urgency band. PAUSED / BLOCKED / CLOSED companies skip this loop entirely
// — they come pre-split from the server in `data.paused` / `data.blocked` /
// `data.closed`.
export function bucketLiveItems(
  companies: DashboardCompany[],
  opportunities: DashboardOpportunity[],
): Record<LiveBucket, LiveBucketContents> {
  const liveBuckets: Record<LiveBucket, LiveBucketContents> = {
    now: { companies: [], opportunities: [] },
    inProcess: { companies: [], opportunities: [] },
    next: { companies: [], opportunities: [] },
    awaitingReply: { companies: [], opportunities: [] },
    watching: { companies: [], opportunities: [] },
  };
  for (const c of companies) {
    liveBuckets[bucketForCompany(c)].companies.push(c);
  }
  for (const o of opportunities) {
    liveBuckets[bucketForOpportunity(o)].opportunities.push(o);
  }
  return liveBuckets;
}
