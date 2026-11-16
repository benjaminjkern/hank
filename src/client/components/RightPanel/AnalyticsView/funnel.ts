// The application-status funnel's data: the category table each bucket rolls
// up into, its colors, the applied-within cutoffs, and the app/company counts.

import type { Application, FunnelBucket } from "@/server/views/analytics";

import type { DefaultTheme } from "styled-components";

export type CatKey =
  | "fresh"
  | "yellow"
  | "orange"
  | "red"
  | "forward"
  | "rejected_early"
  | "rejected_interview"
  | "delisted_no_response"
  | "withdrawn";

export const CATEGORIES: {
  key: CatKey;
  label: string;
  buckets: FunnelBucket[];
}[] = [
  { key: "fresh", label: "≤ 2 weeks", buckets: ["fresh"] },
  { key: "yellow", label: "2–4 weeks", buckets: ["yellow"] },
  { key: "orange", label: "1–2 months", buckets: ["orange"] },
  { key: "red", label: "2+ months", buckets: ["red"] },
  {
    key: "forward",
    label: "In progress",
    buckets: ["responded", "interviewing", "offer"],
  },
  {
    key: "rejected_early",
    label: "Rejected after applying",
    buckets: ["rejected_early"],
  },
  {
    key: "rejected_interview",
    label: "Rejected after interviewing",
    buckets: ["rejected_interview"],
  },
  // Sits with the rejections, not with the awaiting tiers: the posting came
  // down and no reply ever came, which is a non-answer rather than a live
  // application. Distinct from the two above because nobody actually said no.
  {
    key: "delisted_no_response",
    label: "Posting came down, no reply",
    buckets: ["delisted_no_response"],
  },
  { key: "withdrawn", label: "Withdrawn", buckets: ["withdrawn"] },
];

// Unique companies in a set of applications — keyed by companyId when the job
// is linked to a Company, else by the free-text company name. Applications with
// no company at all don't count toward a "company".
function uniqueCompanyCount(apps: Application[]): number {
  const seen = new Set<string>();
  for (const a of apps) {
    const key = a.companyId ?? (a.company ? `name:${a.company}` : null);
    if (key) seen.add(key);
  }
  return seen.size;
}

// "12 apps · 8 companies" — the app-and-company pair shown for the overall
// total and for whichever filter is active.
export function appCompanyLabel(apps: Application[]): string {
  const n = apps.length;
  const c = uniqueCompanyCount(apps);
  return `${n} app${n === 1 ? "" : "s"} · ${c} compan${c === 1 ? "y" : "ies"}`;
}

export function catColor(theme: DefaultTheme, key: CatKey): string {
  switch (key) {
    case "fresh":
      return theme.colors.resting;
    case "yellow":
      return theme.colors.agingYellow;
    case "orange":
      return theme.colors.agingOrange;
    case "red":
      return theme.colors.agingRed;
    case "forward":
      return theme.colors.accent;
    // Darkened so a definitive rejection reads distinct from a stale 2mo+ red;
    // the post-interview one is darker still, having gone further. The
    // posting-came-down case is LIGHTER than both — same family (no offer came
    // of it) but nobody actually rejected you.
    case "rejected_early":
      return `color-mix(in srgb, ${theme.colors.closed}, #000 12%)`;
    case "rejected_interview":
      return `color-mix(in srgb, ${theme.colors.closed}, #000 36%)`;
    case "delisted_no_response":
      return `color-mix(in srgb, ${theme.colors.closed}, #fff 22%)`;
    case "withdrawn":
      return theme.colors.blocked;
  }
}

// Date cutoffs for the application list, in months (null = all time). Older
// applications drift out of relevance, so default to the last year.
export const CUTOFFS: { label: string; months: number | null }[] = [
  { label: "Last 6 months", months: 6 },
  { label: "Last year", months: 12 },
  { label: "Last 2 years", months: 24 },
  { label: "All time", months: null },
];
export const DEFAULT_CUTOFF_MONTHS = 12;
