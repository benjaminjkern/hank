import type { Theme } from "./theme";

// Status-tone categorization. Every JobInteractionStatus / CompanyStatus /
// OpportunityStatus rolls up to exactly one of these seven tones, surfaced
// across the app via status pills, dashboard bucket headers, focus pills,
// and any other status-derived UI.
//
//   focusNow   — Hank's focus right now. Mid-flight work the user actively
//                drives: a fresh pitch, a scan in progress, an approved
//                shortlist row, an open lead, a debrief Hank should pull, a
//                live offer needing a decision. Rendered in the Hank brand
//                purple (same as `accent`) so urgency and brand identity
//                share a color.
//   notStarted — Surfaced but not yet triaged. NEW jobs/companies waiting
//                for the user to look at them. Rendered in dark grey so the
//                eye reads them as "background, not currently competing."
//   resting    — Applied, the ball's in their court (APPLIED, RESPONDED,
//                AWAITING, WAITING_ON_RESPONSE) or a scheduled future event
//                (INTERVIEW_SCHEDULED). Green. The dashboard's "In flight" bucket.
//   watching   — CAUGHT_UP: on the watchlist, intentionally idle, nothing to
//                act on, watching for new postings. Teal — deliberately a
//                different color from `resting` so the "In flight" and
//                "Watching" dashboard buckets don't read as the same thing.
//   deferred   — Set aside for now: a company PAUSED (user stepped away) or a
//                job DEFERRED ("could apply, outranked for now"). Neither closed
//                nor active work — held indefinitely until revived (no timer).
//                Amber so the eye reads "attention later" without focusNow urgency.
//   blocked    — BLOCKED: couldn't read the company's board (a technical
//                set-aside, revive re-hunts). Slate — distinct from `deferred`
//                amber so the "Deferred" and "Blocked" buckets don't collide.
//   closed     — Closed, skipped, or rejected. Terminal for the round.
//
// Authoritative meanings + per-status table live in [docs/lifecycle.md](../../docs/lifecycle.md).
// Keep that doc in sync when this mapping changes.
export type StatusTone =
  | "focusNow"
  | "notStarted"
  | "resting"
  | "watching"
  | "deferred"
  | "blocked"
  | "closed";

export function statusTone(status: string): StatusTone {
  switch (status) {
    // Mid-flight work the user actively drives.
    case "PITCHED": // recruiter pitched it; user owes a triage
    case "SCANNED": // Hank's proposal awaiting shortlist approval
    case "SHORTLISTED": // user approved; ready to apply
    case "SHORTLISTING": // board open, waiting on the user's marks — their turn
    case "APPLYING": // shortlist committed; working the roles that survived
    case "IN_PROCESS": // employer engaged — recruiter replied / interview scheduled; the promising, prep-worthy state
    case "OPEN": // fresh lead, no call scheduled yet
    case "INTERVIEW_DEBRIEF": // interview happened; ask how it went
    case "OFFERED": // offer letter in hand; user owes a decision
      return "focusNow";

    // Surfaced but not yet triaged. SCANNING sits here rather than with the
    // focus states because nothing is being asked of the user while it reads —
    // it's work in progress, not their turn.
    case "NEW": // newly added (job or company); user hasn't looked yet
    case "READY": // company scanned + prescanned, awaiting walkthrough start
    case "SCANNING": // CompanyStatus — entered, reading the board
      return "notStarted";

    // Applied / scheduled — the ball's in their court ("In flight" bucket).
    case "APPLIED":
    case "IN_FLIGHT": // CompanyStatus — >=1 application submitted and still live, no reply yet
    case "RESPONDED": // they replied; if a followup is owed it's a soft one
    case "INTERVIEW_SCHEDULED":
    case "WAITING_ON_RESPONSE": // interview debriefed; waiting on the company's decision. Resting (NOT owed) so it stops nagging in "what's next".
    case "AWAITING": // opportunity awaiting their next step
      return "resting";

    // On the watchlist, idle, watching for new postings. Its own teal tone so
    // the "Watching" bucket doesn't share a color with "In flight".
    case "CAUGHT_UP":
      return "watching";

    // Set aside for now — a company PAUSED (user-driven) or a job DEFERRED
    // ("could apply, outranked for now"). Neither closed nor active work. Amber.
    case "PAUSED": // CompanyStatus (was DEFERRED)
    case "DEFERRED": // JobInteractionStatus (job "outranked for now")
      return "deferred";

    // Set aside for a technical reason — couldn't read the board. Its own slate
    // tone (distinct from DEFERRED amber); revive re-hunts.
    case "BLOCKED":
      return "blocked";

    // Closed.
    case "CLOSED": // user/agent closed it (JobInteractionStatus / CompanyStatus) OR an opportunity that ended
    case "REJECTED":
    case "DELISTED": // the posting came down off the board on its own (JobInteractionStatus, system-set)
      return "closed";

    default:
      return "notStarted";
  }
}

// User-facing label for a raw status / reason enum. The right-panel pills render
// the raw enum verbatim otherwise; this maps the ones whose enum name shouldn't
// show as-is. `CLOSED` Title-cases to "Closed" automatically (the user-close
// status), so it needs no entry. `DELISTED` (posting came down on its own) gets
// a friendlier phrase. Anything unmapped is Title-Cased (NOT_A_MATCH → "Not a
// match").
const STATUS_LABELS: Record<string, string> = {
  DELISTED: "No longer listed",
  SCANNING: "Reading their board", // CompanyStatus — entered, triaging roles
  SHORTLISTING: "Your call", // CompanyStatus — board open, waiting on the user
  APPLYING: "Applying", // CompanyStatus — shortlist committed, working the survivors
  IN_FLIGHT: "In flight", // CompanyStatus — application(s) submitted, awaiting reply
  IN_PROCESS: "In process", // CompanyStatus — employer engaged (recruiter reply / interview)
  PAUSED: "Paused", // CompanyStatus — set aside for now (was DEFERRED)
  CAUGHT_UP: "Caught up",
  BLOCKED: "Couldn't load roles", // CompanyStatus — a technical set-aside, revivable
  INTERVIEW_SCHEDULED: "Interview scheduled",
  INTERVIEW_DEBRIEF: "Interview debrief",
  WAITING_ON_RESPONSE: "Waiting to hear back",
  NOT_A_MATCH: "Not a match",
  LOCATION_MISMATCH: "Location mismatch",
  CANNOT_SCRAPE: "Couldn't load roles",
  AMBIGUOUS_NAME: "Name matches multiple companies",
  NO_OWN_BOARD: "Hires under a parent company",
  AUTH_WALLED: "Board needs a login",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "";
  const mapped = STATUS_LABELS[status];
  if (mapped) return mapped;
  // Title-case the raw enum: SHORTLISTED → "Shortlisted", USER_REJECTED →
  // "User rejected".
  return status
    .split("_")
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase(),
    )
    .join(" ");
}

// Human labels for the company timeline (CompanyEventType). The raw enums are
// multi-word (JOBS_CLOSED / SHORTLIST_RAN / INTERVIEW_SCHEDULED) and read poorly
// verbatim; the summary detail lives in the event's notes, so the label is a
// short category. Applied in CompanyContextView before handing to RecentActivity.
const COMPANY_EVENT_LABELS: Record<string, string> = {
  JOBS_CLOSED: "Roles closed",
  SCRAPE_FOUND: "New roles",
  SHORTLIST_RAN: "Shortlist",
  APPLIED: "Applied",
  RESPONDED: "Response",
  INTERVIEW_SCHEDULED: "Interview scheduled",
  INTERVIEW_HAPPENED: "Interview done",
  OFFERED: "Offer",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
  PAUSED: "Paused",
  BLOCKED: "Set aside",
  CLOSED: "Closed",
  CAUGHT_UP: "Caught up",
  REVIVED: "Revived",
};

export function companyEventLabel(type: string | null | undefined): string {
  if (!type) return "";
  return COMPANY_EVENT_LABELS[type] ?? statusLabel(type);
}

// Past-tense action label for a terminal job, used in "<verb> 3 weeks ago"
// captions. statusLabel covers REJECTED → "Rejected" / DELISTED → "No longer
// listed" / CLOSED → "Closed", but a withdrawn application is a CLOSED row with
// closeReason=WITHDRAWN that should read "Withdrawn", not the generic "Closed".
export function closedActionLabel(
  status: string,
  closeReason: string | null | undefined,
): string {
  if (status === "CLOSED" && closeReason === "WITHDRAWN") return "Withdrawn";
  return statusLabel(status);
}

export function toneColor(theme: Theme, tone: StatusTone): string {
  return theme.colors[tone];
}

export function statusColor(theme: Theme, status: string): string {
  return toneColor(theme, statusTone(status));
}

// Applied-aging escalation. An APPLIED job sitting without a response climbs a
// yellow → orange → red gradient the longer it waits. Thresholds in days since
// the application went out. < 2 weeks stays "fresh" (no escalation — the pill
// keeps its normal resting/green tone). Keep these in sync with the doc comment
// on the aging* theme tokens.
const APPLIED_AGE_YELLOW_DAYS = 14;
const APPLIED_AGE_ORANGE_DAYS = 30;
const APPLIED_AGE_RED_DAYS = 60;

const MS_PER_DAY = 86_400_000;

type AppliedAgeTier = "yellow" | "orange" | "red";

// Escalation tier for an application's age, or null when it doesn't apply (no
// date, unparseable, or still fresh). `nowMs` is passed in rather than read
// here so callers stay React-Compiler-pure (no Date.now() in render scope).
export function appliedAgeTier(
  appliedAtIso: string | null | undefined,
  nowMs: number,
): AppliedAgeTier | null {
  if (!appliedAtIso) return null;
  const t = new Date(appliedAtIso).getTime();
  if (Number.isNaN(t)) return null;
  const days = (nowMs - t) / MS_PER_DAY;
  if (days >= APPLIED_AGE_RED_DAYS) return "red";
  if (days >= APPLIED_AGE_ORANGE_DAYS) return "orange";
  if (days >= APPLIED_AGE_YELLOW_DAYS) return "yellow";
  return null;
}

// Short tier badge appended to an APPLIED job's status chip so its escalating
// color carries an explicit label — multiple "Applied" chips in different
// colors aren't self-explanatory on their own. Returns "" when fresh or not an
// aging applied job; otherwise " >14d" / " >30d" / " >60d" matching the tier.
export function appliedTierBadge(
  appliedAtIso: string | null | undefined,
  nowMs: number,
): string {
  const tier = appliedAgeTier(appliedAtIso, nowMs);
  if (tier === "red") return ` >${APPLIED_AGE_RED_DAYS}d`;
  if (tier === "orange") return ` >${APPLIED_AGE_ORANGE_DAYS}d`;
  if (tier === "yellow") return ` >${APPLIED_AGE_YELLOW_DAYS}d`;
  return "";
}

// Pill color for a *job* status, escalated when it's an APPLIED job aging
// without a response. Everything else (including a fresh APPLIED, or any pill
// where appliedAt / nowMs isn't supplied) falls back to the plain status tone,
// so non-job pills can route through this safely too.
export function jobStatusColor(
  theme: Theme,
  status: string,
  appliedAtIso?: string | null,
  nowMs?: number,
): string {
  if (status === "APPLIED" && appliedAtIso && nowMs != null) {
    const tier = appliedAgeTier(appliedAtIso, nowMs);
    if (tier === "yellow") return theme.colors.agingYellow;
    if (tier === "orange") return theme.colors.agingOrange;
    if (tier === "red") return theme.colors.agingRed;
  }
  return statusColor(theme, status);
}
