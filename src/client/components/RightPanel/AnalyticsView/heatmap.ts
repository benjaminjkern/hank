// Date helpers for the activity heatmap (client-side day bucketing in the
// user's local timezone).

import { dayKey, startOfLocalDay } from "@/shared/utils/date";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// A quarter's worth of weeks — the paging step for the ‹ › arrows.
export const QUARTER_WEEKS = 13;

// Selectable heatmap widths. 3 months is the default; the grid stays horizontally
// scrollable so a wider range still fits the panel.
export const RANGES: { label: string; weeks: number }[] = [
  { label: "3mo", weeks: 13 },
  { label: "6mo", weeks: 26 },
  { label: "1yr", weeks: 53 },
];

type DayCell = { key: string; date: Date; future: boolean; count: number };
export type Week = { days: DayCell[]; monthLabel: string | null };

// Build `weeksToShow` week-columns ending `weeksBack` weeks before the current
// week (0 = window ends at today). Paging back reveals older quarters.
export function buildWeeks(
  countByDay: Map<string, number>,
  now: number,
  weeksToShow: number,
  weeksBack: number,
): Week[] {
  const today = startOfLocalDay(now);
  const currentSunday = new Date(today);
  currentSunday.setDate(today.getDate() - today.getDay());
  const endSunday = new Date(currentSunday);
  endSunday.setDate(currentSunday.getDate() - weeksBack * 7);
  const start = new Date(endSunday);
  start.setDate(endSunday.getDate() - (weeksToShow - 1) * 7);

  const weeks: Week[] = [];
  for (let w = 0; w < weeksToShow; w++) {
    const days: DayCell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + r);
      const future = date.getTime() > today.getTime();
      const key = dayKey(date);
      days.push({
        key,
        date,
        future,
        count: future ? 0 : (countByDay.get(key) ?? 0),
      });
    }
    weeks.push({ days, monthLabel: null });
  }
  let prevMonth = -1;
  for (const wk of weeks) {
    const m = wk.days[0].date.getMonth();
    if (m !== prevMonth) {
      wk.monthLabel = MONTHS[m];
      prevMonth = m;
    }
  }
  return weeks;
}

export function cellLevel(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

export function levelMix(level: number): string {
  switch (level) {
    case 1:
      return "22%";
    case 2:
      return "45%";
    case 3:
      return "68%";
    default:
      return "90%";
  }
}
