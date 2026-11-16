// Payload for the user-facing Analytics page. Two independent views:
//   - `advancements`: forward-progress events over the last ~year, for the
//     activity grid + per-day list. Day-bucketing is left to the client (from
//     raw occurredAt) so the grid aligns to the user's timezone.
//   - `applications`: every ever-applied JobInteraction, each tagged with the
//     funnel `bucket` it lands in. The client derives the breakdown counts and
//     renders a filterable list. Built by loadAnalytics
//     (server/views/analytics.ts).
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
