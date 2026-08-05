// Date/time rendering. Presentation only — every function here takes an
// instant and returns a string for a human to read.

import { nowMs } from "./now";

// Short relative-time string for UI labels: "just now" / "5m ago" / "3d ago".
// The client-facing variant (with the "ago" suffix). `relativeAge` below is the
// bare-duration variant used by server-side agent tooling.
export function relativeTime(at: string | Date): string {
  const then = (typeof at === "string" ? new Date(at) : at).getTime();
  const diffSec = Math.round((nowMs() - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.round(diffMonth / 12)}y ago`;
}

// Bare-duration variant (no "ago" suffix), between two explicit Dates: "5m" /
// "3h" / "12d" / "4mo". Used for compact server-rendered labels like the
// list_companies "scanned 3d ago" column.
export function relativeAge(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMonth = Math.round(diffDay / 30);
  return `${diffMonth}mo`;
}

// "Mon, Sep 3" — a date a person reads at a glance, no year. For grid/tooltip
// labels where the year is implied by context.
export function fullDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// "Sep 3, 02:14 PM" — date + clock, no year.
export function shortDateTime(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "Mon, Sep 3, 2:14 PM" — the weekday-bearing variant, for a scheduled moment
// a person needs to place in their week.
export function fullDateTime(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Bare calendar date in the viewer's locale, e.g. "9/3/2026".
export function shortDate(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toLocaleDateString();
}

// Midnight at the start of the instant's LOCAL day — the bucket boundary for
// per-day grouping (activity grids, streaks) in the viewer's own timezone.
export function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Stable "YYYY-MM-DD" key for a LOCAL day — sortable, and safe as a Map key.
// Deliberately not toISOString(), which would shift the day across the UTC
// boundary for anyone west of Greenwich.
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
