import { JobEventType, JobInteractionStatus } from "@/generated/prisma/client";
import { appliedAgeTier } from "@/lib/statusColors";
import { prisma } from "@/server/db/prisma";
import { nowMs } from "@/utils/now";

// Payload for the user-facing Analytics page. Two independent views:
//   - `advancements`: forward-progress events over the last ~year, for the
//     activity grid + per-day list. Day-bucketing is left to the client (from
//     raw occurredAt) so the grid aligns to the user's timezone.
//   - `applications`: every ever-applied JobInteraction, each tagged with the
//     funnel `bucket` it lands in. The client derives the breakdown counts and
//     renders a filterable list. Mirrors the Documents pattern (type + loader
//     here, thin route + client import).
export type AdvancementCategory =
  "APPLIED" | "RESPONDED" | "INTERVIEW" | "OFFER" | "REJECTED";

// One dot on the activity grid. Despite the "Advancement" name it also carries
// REJECTED events now — they're real activity worth surfacing, toggleable client-side.
export type Advancement = {
  occurredAt: string; // ISO; client buckets by local day
  type: AdvancementCategory;
  company: string | null;
  companyId: string | null; // clickable → company page when set
};

// Leaf buckets a still-relevant application falls into. The awaiting tiers
// mirror appliedAgeTier (null => "fresh"); the rest track the funnel beyond.
export type FunnelBucket =
  | "fresh"
  | "yellow"
  | "orange"
  | "red" // applied, no response yet (by age)
  | "responded"
  | "interviewing"
  | "offer" // moved forward
  | "rejected_early" // company said no, before any interview happened
  | "rejected_interview" // company said no, after an interview process
  | "delisted_no_response" // posting came down while the application sat unanswered
  | "withdrawn"; // you pulled out / closed it

export type Application = {
  jobInteractionId: string;
  jobId: string;
  title: string;
  company: string | null;
  companyId: string | null;
  status: string; // current JobInteractionStatus
  bucket: FunnelBucket;
  appliedAt: string; // ISO of the latest APPLIED event; client filters by age
};

export type AnalyticsData = {
  advancements: Advancement[];
  applications: Application[];
};

// Event types that land on the activity grid. Mostly forward "advancements";
// REJECTED is included too (real activity — the client can toggle it off).
// INTERVIEW_SCHEDULED's occurredAt is the call time (the interview day);
// INTERVIEW_HAPPENED is deliberately excluded so a scheduled-then-happened
// interview isn't counted twice.
const ADVANCEMENT_EVENT_TYPES = [
  JobEventType.APPLIED,
  JobEventType.RESPONDED,
  JobEventType.INTERVIEW_SCHEDULED,
  JobEventType.OFFERED,
  JobEventType.REJECTED,
] as const;

// Event types that mean an interview process actually got underway (a screen or
// interview was scheduled or happened). Used to split a REJECTED JobInteraction
// into "rejected before any interview" vs "rejected after interviewing" — the
// current status is a flat REJECTED, so the Event history is the only signal.
const INTERVIEW_STAGE_EVENT_TYPES = [
  JobEventType.INTERVIEW_SCHEDULED,
  JobEventType.INTERVIEW_HAPPENED,
] as const;

function advancementCategory(type: JobEventType): AdvancementCategory | null {
  switch (type) {
    case JobEventType.APPLIED:
      return "APPLIED";
    case JobEventType.RESPONDED:
      return "RESPONDED";
    case JobEventType.INTERVIEW_SCHEDULED:
      return "INTERVIEW";
    case JobEventType.OFFERED:
      return "OFFER";
    case JobEventType.REJECTED:
      return "REJECTED";
    default:
      return null;
  }
}

// Statuses meaning "applied, and the company hasn't come back" — the only ones
// a taken-down posting reinterprets. Anything further along (RESPONDED /
// interviewing / OFFERED / REJECTED) has a real outcome that outranks the
// posting's fate, and CLOSED means the user withdrew.
const AWAITING_REPLY_STATUSES = new Set<JobInteractionStatus>([
  JobInteractionStatus.APPLIED,
  JobInteractionStatus.DEFERRED,
]);

function bucketFor(
  status: JobInteractionStatus,
  appliedAtIso: string | undefined,
  now: number,
  hadInterview: boolean,
  postingClosed: boolean,
): FunnelBucket {
  // Applied, and then the posting came down with the company never replying —
  // a non-answer, not a live application. Two ways to land here: a rescrape
  // stamped Job.closedAt (which leaves the row in APPLIED, since closure
  // detection only flips the non-applied statuses), or someone set DELISTED by
  // hand. Checked first, because otherwise the former ages through the "no
  // response yet" tiers forever as if it were still in play and the latter
  // falls to `withdrawn`, reading as though the user pulled out.
  if (
    status === JobInteractionStatus.DELISTED ||
    (postingClosed && AWAITING_REPLY_STATUSES.has(status))
  ) {
    return "delisted_no_response";
  }
  switch (status) {
    // Applied and waiting (DEFERRED = applied then paused — still no reply).
    case JobInteractionStatus.APPLIED:
    case JobInteractionStatus.DEFERRED: {
      const tier = appliedAgeTier(appliedAtIso, now);
      return tier === "red"
        ? "red"
        : tier === "orange"
          ? "orange"
          : tier === "yellow"
            ? "yellow"
            : "fresh";
    }
    case JobInteractionStatus.RESPONDED:
      return "responded";
    case JobInteractionStatus.INTERVIEW_SCHEDULED:
    case JobInteractionStatus.INTERVIEW_DEBRIEF:
    // Debriefed, waiting on the company's decision — ball in their court, but
    // it went further than a plain response. In-progress, NOT withdrawn.
    case JobInteractionStatus.WAITING_ON_RESPONSE:
      return "interviewing";
    case JobInteractionStatus.OFFERED:
      return "offer";
    case JobInteractionStatus.REJECTED:
      return hadInterview ? "rejected_interview" : "rejected_early";
    // CLOSED = withdrew/closed after applying. Any other status with an APPLIED
    // event in history shouldn't occur (status only moves forward), but bucket
    // it here so the list stays complete.
    default:
      return "withdrawn";
  }
}

export async function loadAnalytics(userId: string): Promise<AnalyticsData> {
  const now = nowMs();

  // --- Activity grid + list: all-time activity events ---
  // No date window: advancement/rejection events per user are small (bounded by
  // real activity), so we return the full history and let the client window it
  // (3mo default + quarter paging). Paging then bounds naturally at the earliest
  // real event rather than an arbitrary server cap.
  const events = await prisma.jobEvent.findMany({
    where: {
      type: { in: [...ADVANCEMENT_EVENT_TYPES] },
      jobInteraction: { userId },
    },
    select: {
      type: true,
      occurredAt: true,
      jobInteraction: {
        select: {
          job: {
            select: {
              companyId: true,
              companyName: true,
              company: { select: { name: true } },
            },
          },
        },
      },
    },
    orderBy: { occurredAt: "desc" },
  });
  const advancements: Advancement[] = [];
  for (const e of events) {
    const type = advancementCategory(e.type);
    if (!type) continue;
    const job = e.jobInteraction.job;
    advancements.push({
      occurredAt: e.occurredAt.toISOString(),
      type,
      company: job.company?.name ?? job.companyName,
      companyId: job.companyId,
    });
  }

  // --- Applications: every JobInteraction that ever had an APPLIED event ---
  // groupBy + _max gets the latest APPLIED date per JobInteraction regardless of
  // later events (a DRAFT_USED logged after applying, or a backdated apply) —
  // same fix the dashboard uses. No status filter, so it also catches rows that
  // have since progressed / been rejected / withdrawn.
  const appliedRows = await prisma.jobEvent.groupBy({
    by: ["jobInteractionId"],
    where: { type: JobEventType.APPLIED, jobInteraction: { userId } },
    _max: { occurredAt: true },
  });
  const appliedAtById = new Map<string, string>(
    appliedRows
      .filter((r) => r._max.occurredAt)
      .map((r) => [r.jobInteractionId, r._max.occurredAt!.toISOString()]),
  );
  const ids = [...appliedAtById.keys()];

  // Which of those JobInteractions ever reached an interview stage — used to split
  // the REJECTED bucket. One grouped query over the same id set.
  const interviewRows = ids.length
    ? await prisma.jobEvent.groupBy({
        by: ["jobInteractionId"],
        where: {
          jobInteractionId: { in: ids },
          type: { in: [...INTERVIEW_STAGE_EVENT_TYPES] },
        },
      })
    : [];
  const hadInterviewById = new Set(
    interviewRows.map((r) => r.jobInteractionId),
  );

  const jobInteractions = ids.length
    ? await prisma.jobInteraction.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          status: true,
          job: {
            select: {
              id: true,
              title: true,
              companyId: true,
              companyName: true,
              // The global "posting taken down" date — what separates an
              // application still in play from one whose posting vanished.
              closedAt: true,
              company: { select: { name: true } },
            },
          },
        },
      })
    : [];

  const applications: Application[] = jobInteractions
    .map((i) => ({
      jobInteractionId: i.id,
      jobId: i.job.id,
      title: i.job.title,
      company: i.job.company?.name ?? i.job.companyName,
      companyId: i.job.companyId,
      status: i.status,
      appliedAt: appliedAtById.get(i.id) ?? "",
      bucket: bucketFor(
        i.status,
        appliedAtById.get(i.id),
        now,
        hadInterviewById.has(i.id),
        i.job.closedAt != null,
      ),
    }))
    // Most-recently-applied first, so the client's capped list shows the
    // latest applications. ISO timestamps sort lexically = chronologically.
    .sort((a, b) =>
      (appliedAtById.get(b.jobInteractionId) ?? "").localeCompare(
        appliedAtById.get(a.jobInteractionId) ?? "",
      ),
    );

  return { advancements, applications };
}
