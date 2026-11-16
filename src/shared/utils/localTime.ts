// Timezone-aware event-time handling. Hank has no stored timezone; the browser
// sends its IANA zone (e.g. "America/Los_Angeles") with each chat message, and
// it flows to two places:
//   * renderTodayBlock  — so the agent sees the current LOCAL date+time and can
//                         resolve "tomorrow at 2pm" against the right clock.
//   * the event tools    — so a wall-clock time the agent logs is stored at the
//                         right UTC instant, not pinned to 00:00Z.
//
// The bug this fixes: date-only strings ("2026-06-14") parsed via `new Date()`
// land at midnight UTC, so a same-day interview reads as already past and
// flipDueInterviews prematurely promotes it to INTERVIEW_DEBRIEF.

const UTC = "UTC";

// Guard an untrusted IANA zone string. Intl throws on an invalid zone, so we
// probe it once and fall back to UTC. Empty/undefined -> UTC.
function normalizeTimeZone(tz: string | null | undefined): string {
  if (!tz) return UTC;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return UTC;
  }
}

// Milliseconds the zone is AHEAD of UTC at the given instant (negative west of
// UTC). Computed by formatting the instant in the zone and diffing against UTC —
// the standard no-dependency approach.
function zoneOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asIfUtc - instant.getTime();
}

// Convert a wall-clock time (as if it were UTC fields) in a zone to the real UTC
// instant. Applies the offset twice to settle DST boundaries (accurate except
// inside the ~1h transition window, which we don't care about for event times).
function wallClockToUtc(wallAsUtcMs: number, tz: string): Date {
  const guess = new Date(wallAsUtcMs);
  const off1 = zoneOffsetMs(guess, tz);
  const corrected = new Date(wallAsUtcMs - off1);
  const off2 = zoneOffsetMs(corrected, tz);
  return off2 === off1 ? corrected : new Date(wallAsUtcMs - off2);
}

// Matches an ISO string that already pins an absolute instant — a trailing Z or
// a ±HH:MM offset. Those are unambiguous; parse them straight.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;
// Date only, no time-of-day.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Wall-clock date+time, no offset (the case we must interpret in the user's zone).
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

// Parse an agent-supplied event date/time into a UTC Date, interpreting naked
// wall-clock times in the user's zone. Returns null on unparseable input so the
// caller can fall back to `new Date()` (now).
export function parseEventDateTime(
  input: string | null | undefined,
  timeZone: string | null | undefined,
): Date | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const tz = normalizeTimeZone(timeZone);

  // Already absolute (has Z or an offset) — trust it.
  if (HAS_OFFSET.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Date only — interpret as local midnight in the user's zone. (Untimed events
  // like APPLIED aren't time-gated, so midnight-local is fine and still beats
  // midnight-UTC for anyone west/east of UTC.)
  if (DATE_ONLY.test(raw)) {
    const [y, mo, d] = raw.split("-").map(Number);
    return wallClockToUtc(Date.UTC(y, mo - 1, d, 0, 0, 0), tz);
  }

  // Wall-clock date+time with no offset — the important case. Interpret the
  // clock time in the user's zone.
  const m = WALL_CLOCK.exec(raw);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return wallClockToUtc(Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0), tz);
  }

  // Anything else (freeform) — last resort, let Date try; null if it can't.
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Render the current moment for the # Today block: local date, local time, and
// the zone, so the agent can anchor relative times ("tomorrow at 2pm").
export function formatNowInZone(
  now: Date,
  timeZone: string | null | undefined,
): { dateLabel: string; timeLabel: string; zone: string } {
  const zone = normalizeTimeZone(timeZone);
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: zone,
  });
  const timeLabel = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: zone,
  });
  return { dateLabel, timeLabel, zone };
}

// Format an event's stored instant back in the user's zone for display /
// agent-facing history. Shows the clock time when the event carries one (so a
// "2pm interview" reads as 2pm, not the UTC hour) but stays date-only for
// untimed events (which land at local midnight) so they don't render a noisy
// "12:00 AM". Returns YYYY-MM-DD, optionally " h:mm AM/PM".
export function formatEventStamp(
  instant: Date,
  timeZone: string | null | undefined,
): string {
  const zone = normalizeTimeZone(timeZone);
  const date = instant.toLocaleDateString("en-CA", { timeZone: zone }); // ISO-ish
  const hm = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const hh = hm.find((p) => p.type === "hour")?.value;
  const mm = hm.find((p) => p.type === "minute")?.value;
  if (hh === "00" && mm === "00") return date; // local midnight — untimed event
  const time = instant.toLocaleTimeString("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}
