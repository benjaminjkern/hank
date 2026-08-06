"use client";

import { useEffect, useMemo, useState } from "react";
import styled, { type DefaultTheme } from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import { withImpersonate } from "@/lib/impersonation";
import { statusColor, statusLabel } from "@/lib/statusColors";
import type {
  AnalyticsData,
  Advancement,
  AdvancementCategory,
  Application,
  FunnelBucket,
} from "@/server/views/analytics";
import { dayKey, fullDate, relativeTime, startOfLocalDay } from "@/utils/date";
import { nowMs } from "@/utils/now";

import { useExpandable } from "./shared/useExpandable";

// ---------------------------------------------------------------------------
// Date helpers (client-side day bucketing in the user's local timezone)
// ---------------------------------------------------------------------------

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
const QUARTER_WEEKS = 13;

// Selectable heatmap widths. 3 months is the default; the grid stays horizontally
// scrollable so a wider range still fits the panel.
const RANGES: { label: string; weeks: number }[] = [
  { label: "3mo", weeks: 13 },
  { label: "6mo", weeks: 26 },
  { label: "1yr", weeks: 53 },
];

type DayCell = { key: string; date: Date; future: boolean; count: number };
type Week = { days: DayCell[]; monthLabel: string | null };

// Build `weeksToShow` week-columns ending `weeksBack` weeks before the current
// week (0 = window ends at today). Paging back reveals older quarters.
function buildWeeks(
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

function cellLevel(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

function levelMix(level: number): string {
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

// ---------------------------------------------------------------------------
// Advancement presentation
// ---------------------------------------------------------------------------

function categoryColor(theme: DefaultTheme, c: AdvancementCategory): string {
  switch (c) {
    case "APPLIED":
      return theme.colors.accent;
    case "RESPONDED":
      return theme.colors.watching;
    case "INTERVIEW":
      return theme.colors.resting;
    case "OFFER":
      return theme.colors.agingYellow;
    case "REJECTED":
      return theme.colors.closed;
  }
}

// Tooltip summary: a day's advancements grouped by CATEGORY (not company).
function categorySummary(items: Advancement[]): string {
  const counts = {
    APPLIED: 0,
    RESPONDED: 0,
    INTERVIEW: 0,
    OFFER: 0,
    REJECTED: 0,
  } as Record<AdvancementCategory, number>;
  for (const a of items) counts[a.type]++;
  const parts: string[] = [];
  if (counts.APPLIED) parts.push(`${counts.APPLIED} applied`);
  if (counts.RESPONDED)
    parts.push(
      `${counts.RESPONDED} response${counts.RESPONDED > 1 ? "s" : ""}`,
    );
  if (counts.INTERVIEW)
    parts.push(
      `${counts.INTERVIEW} interview${counts.INTERVIEW > 1 ? "s" : ""}`,
    );
  if (counts.OFFER)
    parts.push(`${counts.OFFER} offer${counts.OFFER > 1 ? "s" : ""}`);
  if (counts.REJECTED)
    parts.push(`${counts.REJECTED} rejection${counts.REJECTED > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

// One list line = a (category, company) group → lead text + (clickable) company.
type LineGroup = {
  cat: AdvancementCategory;
  company: string | null;
  companyId: string | null;
  lead: string;
};

function lineLead(
  cat: AdvancementCategory,
  hasCompany: boolean,
  count: number,
): string {
  switch (cat) {
    case "APPLIED":
      if (hasCompany)
        return count > 1
          ? `Applied to ${count} roles at `
          : "Applied to a role at ";
      return count > 1 ? `Applied to ${count} roles` : "Applied to a role";
    case "RESPONDED":
      return hasCompany ? "Heard back from " : "Heard back";
    case "INTERVIEW":
      if (hasCompany)
        return count > 1 ? `${count} interviews at ` : "Interview at ";
      return count > 1 ? `${count} interviews` : "Interview";
    case "OFFER":
      return hasCompany ? "Offer from " : "Offer";
    case "REJECTED":
      if (hasCompany)
        return count > 1 ? `${count} rejections from ` : "Rejected by ";
      return count > 1 ? `${count} rejections` : "Rejected";
  }
}

const CATEGORY_ORDER: AdvancementCategory[] = [
  "OFFER",
  "INTERVIEW",
  "RESPONDED",
  "APPLIED",
  "REJECTED",
];

function groupDay(items: Advancement[]): LineGroup[] {
  const map = new Map<
    string,
    {
      cat: AdvancementCategory;
      company: string | null;
      companyId: string | null;
      count: number;
    }
  >();
  for (const a of items) {
    const key = `${a.type}|${a.companyId ?? a.company ?? ""}`;
    const ex = map.get(key);
    if (ex) ex.count++;
    else
      map.set(key, {
        cat: a.type,
        company: a.company,
        companyId: a.companyId,
        count: 1,
      });
  }
  return [...map.values()]
    .sort(
      (a, b) => CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat),
    )
    .map((g) => ({
      cat: g.cat,
      company: g.company,
      companyId: g.companyId,
      lead: lineLead(g.cat, !!g.company, g.count),
    }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AnalyticsView() {
  const impersonate = useChatStore((s) => s.impersonateSessionId);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(withImpersonate("/api/analytics", impersonate))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: AnalyticsData) => {
        if (!cancelled) {
          setData(d);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [impersonate]);

  if (loadError)
    return (
      <Empty>
        Couldn&apos;t load your analytics — reopen this view to retry.
      </Empty>
    );
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <Wrap>
      <PageHead>
        <PageTitle>Analytics</PageTitle>
        <PageHint>
          Your search at a glance — daily activity and where every application
          stands.
        </PageHint>
      </PageHead>
      <ActivitySection advancements={data.advancements} />
      <FunnelSection applications={data.applications} />
    </Wrap>
  );
}

// ---- Activity: heatmap + per-day list --------------------------------------

type HoverTip = { left: number; top: number; date: string; summary: string };

function ActivitySection({ advancements }: { advancements: Advancement[] }) {
  const viewCompany = useChatStore((s) => s.viewCompany);
  const now = nowMs();
  const [tip, setTip] = useState<HoverTip | null>(null);
  const [showRejections, setShowRejections] = useState(true);
  const [rangeWeeks, setRangeWeeks] = useState(RANGES[0].weeks); // 3mo default
  const [weeksBack, setWeeksBack] = useState(0);

  // Rejection dots are toggleable; hiding them affects both the heatmap and the
  // day list (and the earliest-data bound that gates back-paging).
  const visible = useMemo(
    () =>
      showRejections
        ? advancements
        : advancements.filter((a) => a.type !== "REJECTED"),
    [advancements, showRejections],
  );

  const { countByDay, summaryByDay, dayGroups } = useMemo(() => {
    const groups = new Map<string, Advancement[]>();
    for (const a of visible) {
      const key = dayKey(new Date(a.occurredAt));
      const arr = groups.get(key);
      if (arr) arr.push(a);
      else groups.set(key, [a]);
    }
    const counts = new Map<string, number>();
    const summaries = new Map<string, string>();
    for (const [k, items] of groups) {
      counts.set(k, items.length);
      summaries.set(k, categorySummary(items));
    }
    const ordered = [...groups.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, items]) => ({ key, items, latest: items[0].occurredAt }));
    return { countByDay: counts, summaryByDay: summaries, dayGroups: ordered };
  }, [visible]);

  const weeks = useMemo(
    () => buildWeeks(countByDay, now, rangeWeeks, weeksBack),
    [countByDay, now, rangeWeeks, weeksBack],
  );

  // Oldest visible event → how far back paging can go. The ‹ arrow disables once
  // the window's first day reaches it (no older data to reveal).
  const earliestMs = useMemo(() => {
    let min = Infinity;
    for (const a of visible) {
      const t = new Date(a.occurredAt).getTime();
      if (t < min) min = t;
    }
    return min;
  }, [visible]);
  const windowStartMs = weeks[0]?.days[0]?.date.getTime() ?? 0;
  const canGoBack = Number.isFinite(earliestMs) && windowStartMs > earliestMs;
  const canGoForward = weeksBack > 0;

  return (
    <Card>
      <SectionHead>
        <SectionTitle>Activity</SectionTitle>
        <SectionCount>
          {visible.length} update{visible.length === 1 ? "" : "s"} ·{" "}
          {dayGroups.length} active day{dayGroups.length === 1 ? "" : "s"}
        </SectionCount>
      </SectionHead>

      <ControlsRow>
        <RangeChips>
          {RANGES.map((r) => (
            <RangeChip
              key={r.weeks}
              type="button"
              $active={rangeWeeks === r.weeks}
              onClick={() => setRangeWeeks(r.weeks)}
            >
              {r.label}
            </RangeChip>
          ))}
          <PageArrow
            type="button"
            aria-label="Earlier"
            disabled={!canGoBack}
            onClick={() => setWeeksBack((n) => n + QUARTER_WEEKS)}
          >
            ‹
          </PageArrow>
          <PageArrow
            type="button"
            aria-label="Later"
            disabled={!canGoForward}
            onClick={() => setWeeksBack((n) => Math.max(0, n - QUARTER_WEEKS))}
          >
            ›
          </PageArrow>
        </RangeChips>
        <ToggleLabel>
          <input
            type="checkbox"
            checked={showRejections}
            onChange={(e) => setShowRejections(e.target.checked)}
          />
          Show rejections
        </ToggleLabel>
      </ControlsRow>

      <GridScroll>
        <Grid>
          <MonthsRow>
            <WeekdaySpacer />
            {weeks.map((w, i) => (
              <MonthSlot key={i}>{w.monthLabel ?? ""}</MonthSlot>
            ))}
          </MonthsRow>
          <GridBody>
            <WeekdayCol>
              {["", "Mon", "", "Wed", "", "Fri", ""].map((d, i) => (
                <WeekdayLabel key={i}>{d}</WeekdayLabel>
              ))}
            </WeekdayCol>
            <Weeks>
              {weeks.map((w, i) => (
                <WeekCol key={i}>
                  {w.days.map((d) => (
                    <Cell
                      key={d.key}
                      $level={cellLevel(d.count)}
                      $future={d.future}
                      onMouseEnter={(e) => {
                        if (d.future || d.count === 0) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        setTip({
                          left: r.left + r.width / 2,
                          top: r.top,
                          date: fullDate(d.date),
                          summary: summaryByDay.get(d.key) ?? "",
                        });
                      }}
                      onMouseLeave={() => setTip(null)}
                    />
                  ))}
                </WeekCol>
              ))}
            </Weeks>
          </GridBody>
          <LegendRow>
            <LegendLabel>Less</LegendLabel>
            {[0, 1, 2, 3, 4].map((l) => (
              <Cell key={l} $level={l} />
            ))}
            <LegendLabel>More</LegendLabel>
          </LegendRow>
        </Grid>
      </GridScroll>

      {tip && (
        <Tooltip style={{ left: tip.left, top: tip.top }}>
          <TipSummary>{tip.summary}</TipSummary>
          <TipDate>{tip.date}</TipDate>
        </Tooltip>
      )}

      {dayGroups.length === 0 ? (
        <Empty>No activity yet.</Empty>
      ) : (
        <DayList
          groups={dayGroups}
          onPickCompany={(id) => void viewCompany(id)}
        />
      )}
    </Card>
  );
}

function DayList({
  groups,
  onPickCompany,
}: {
  groups: { key: string; items: Advancement[]; latest: string }[];
  onPickCompany: (companyId: string) => void;
}) {
  const { visible, truncated, canCollapse, hiddenCount, expand, collapse } =
    useExpandable(groups, 10);
  return (
    <>
      {visible.map((g) => (
        <DayBlock key={g.key}>
          <DayHeader>
            <DayWhen>{relativeTime(g.latest)}</DayWhen>
            <DayDate>{fullDate(new Date(g.latest))}</DayDate>
          </DayHeader>
          {groupDay(g.items).map((line, i) => (
            <DayLine key={i}>
              <Dot $color={(t) => categoryColor(t, line.cat)} />
              <span>
                {line.lead}
                {line.company &&
                  (line.companyId ? (
                    <CompanyLink
                      type="button"
                      onClick={() => onPickCompany(line.companyId!)}
                    >
                      {line.company}
                    </CompanyLink>
                  ) : (
                    line.company
                  ))}
              </span>
            </DayLine>
          ))}
        </DayBlock>
      ))}
      {truncated ? (
        <MoreButton onClick={expand}>
          Show {hiddenCount} more day{hiddenCount === 1 ? "" : "s"}
        </MoreButton>
      ) : canCollapse ? (
        <MoreButton onClick={collapse}>Collapse</MoreButton>
      ) : null}
    </>
  );
}

// ---- Funnel: merged bar + clickable category filters + job list ------------

type CatKey =
  | "fresh"
  | "yellow"
  | "orange"
  | "red"
  | "forward"
  | "rejected_early"
  | "rejected_interview"
  | "delisted_no_response"
  | "withdrawn";

const CATEGORIES: { key: CatKey; label: string; buckets: FunnelBucket[] }[] = [
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
function appCompanyLabel(apps: Application[]): string {
  const n = apps.length;
  const c = uniqueCompanyCount(apps);
  return `${n} app${n === 1 ? "" : "s"} · ${c} compan${c === 1 ? "y" : "ies"}`;
}

// Approximate heights used to reserve the list's min-height so filtering
// doesn't shrink the panel (see FunnelSection). Deliberately a hair taller
// than the real rows so the tallest collapsed state is always covered.
const RESERVE_ROW_H = 52; // px ≈ one application row (title + company + padding)
const RESERVE_MORE_H = 40; // px ≈ the "Show N more" button row

function catColor(theme: DefaultTheme, key: CatKey): string {
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
const CUTOFFS: { label: string; months: number | null }[] = [
  { label: "Last 6 months", months: 6 },
  { label: "Last year", months: 12 },
  { label: "Last 2 years", months: 24 },
  { label: "All time", months: null },
];
const DEFAULT_CUTOFF_MONTHS = 12;

function FunnelSection({ applications }: { applications: Application[] }) {
  const viewJob = useChatStore((s) => s.viewJob);
  const viewCompany = useChatStore((s) => s.viewCompany);
  const now = nowMs();
  const [filter, setFilter] = useState<Set<CatKey>>(() => new Set());
  const [cutoffMonths, setCutoffMonths] = useState<number | null>(
    DEFAULT_CUTOFF_MONTHS,
  );

  // Applications applied within the chosen window. Everything below (funnel bar,
  // legend counts, list) works off this — the category filter composes on top.
  const windowed = useMemo(() => {
    if (cutoffMonths == null) return applications;
    const threshold = new Date(now);
    threshold.setMonth(threshold.getMonth() - cutoffMonths);
    const t = threshold.getTime();
    return applications.filter(
      (a) => !a.appliedAt || new Date(a.appliedAt).getTime() >= t,
    );
  }, [applications, now, cutoffMonths]);

  const total = windowed.length;

  const categories = useMemo(() => {
    const byBucket = new Map<FunnelBucket, number>();
    for (const a of windowed)
      byBucket.set(a.bucket, (byBucket.get(a.bucket) ?? 0) + 1);
    return CATEGORIES.map((c) => ({
      ...c,
      count: c.buckets.reduce((n, b) => n + (byBucket.get(b) ?? 0), 0),
    })).filter((c) => c.count > 0);
  }, [windowed]);

  // Categories currently selected, in CATEGORIES order. Empty = no filter.
  const activeCats = CATEGORIES.filter((c) => filter.has(c.key));
  const activeBuckets = new Set<FunnelBucket>(
    activeCats.flatMap((c) => c.buckets),
  );
  const filtered =
    activeCats.length > 0
      ? windowed.filter((a) => activeBuckets.has(a.bucket))
      : windowed;

  // Reserve the height of the tallest collapsed state (the unfiltered list,
  // capped at 10) so narrowing to a filter with fewer rows doesn't shrink the
  // panel and make it snap as the page reflows.
  const reservedRows = Math.min(10, total);
  const reservedMinHeight =
    reservedRows * RESERVE_ROW_H + (total > 10 ? RESERVE_MORE_H : 0);

  function pick(key: CatKey) {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Card>
      <SectionHead>
        <SectionTitle>Application status</SectionTitle>
        <SectionCount>{appCompanyLabel(windowed)}</SectionCount>
      </SectionHead>

      {applications.length === 0 ? (
        <Empty>
          No applications yet — once you apply, the breakdown shows up here.
        </Empty>
      ) : (
        <>
          <ControlsRow>
            <ToggleLabel>
              Applied within
              <CutoffSelect
                value={cutoffMonths == null ? "all" : String(cutoffMonths)}
                onChange={(e) =>
                  setCutoffMonths(
                    e.target.value === "all" ? null : Number(e.target.value),
                  )
                }
              >
                {CUTOFFS.map((c) => (
                  <option
                    key={c.label}
                    value={c.months == null ? "all" : String(c.months)}
                  >
                    {c.label}
                  </option>
                ))}
              </CutoffSelect>
            </ToggleLabel>
          </ControlsRow>

          {total === 0 ? (
            <Empty>No applications in this time range.</Empty>
          ) : (
            <FunnelBody>
              <Bar>
                {categories.map((c) => (
                  <Seg
                    key={c.key}
                    $color={(t) => catColor(t, c.key)}
                    $grow={c.count}
                    $dim={activeCats.length > 0 && !filter.has(c.key)}
                  />
                ))}
              </Bar>
              <Legend>
                {categories.map((c) => (
                  <LegendItem
                    key={c.key}
                    type="button"
                    $active={filter.has(c.key)}
                    onClick={() => pick(c.key)}
                  >
                    <Dot $color={(t) => catColor(t, c.key)} />
                    {c.label} <LegendNum>{c.count}</LegendNum>
                  </LegendItem>
                ))}
              </Legend>

              <ListHeader>
                <ListLabel>
                  Applications
                  {activeCats.map((c) => (
                    <FilterTag key={c.key}>{c.label}</FilterTag>
                  ))}
                  <ListCount>{appCompanyLabel(filtered)}</ListCount>
                </ListLabel>
                {activeCats.length > 0 && (
                  <ClearBtn type="button" onClick={() => setFilter(new Set())}>
                    Clear filter
                  </ClearBtn>
                )}
              </ListHeader>

              <AppList
                apps={filtered}
                minHeight={reservedMinHeight}
                onPickJob={(id) => void viewJob(id)}
                onPickCompany={(id) => void viewCompany(id)}
              />
            </FunnelBody>
          )}
        </>
      )}
    </Card>
  );
}

function AppList({
  apps,
  minHeight,
  onPickJob,
  onPickCompany,
}: {
  apps: Application[];
  minHeight: number;
  onPickJob: (jobId: string) => void;
  onPickCompany: (companyId: string) => void;
}) {
  const { visible, truncated, canCollapse, hiddenCount, expand, collapse } =
    useExpandable(apps, 10);
  return (
    <AppRows style={{ minHeight }}>
      {apps.length === 0 ? (
        <SubHint>No applications in this category.</SubHint>
      ) : (
        <>
          {visible.map((a) => (
            <AppRow key={a.jobInteractionId} onClick={() => onPickJob(a.jobId)}>
              <AppMain>
                <AppTitle>{a.title}</AppTitle>
                {a.company &&
                  (a.companyId ? (
                    <AppCompany
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPickCompany(a.companyId!);
                      }}
                    >
                      {a.company}
                    </AppCompany>
                  ) : (
                    <AppCompanyText>{a.company}</AppCompanyText>
                  ))}
              </AppMain>
              <StatusPill $status={a.status}>
                {statusLabel(a.status)}
              </StatusPill>
            </AppRow>
          ))}
          {truncated ? (
            <MoreButton onClick={expand}>Show {hiddenCount} more</MoreButton>
          ) : canCollapse ? (
            <MoreButton onClick={collapse}>Collapse</MoreButton>
          ) : null}
        </>
      )}
    </AppRows>
  );
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
`;

const PageHead = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
  margin-bottom: ${({ theme }) => theme.space.xs};
`;

const PageTitle = styled.h2`
  font-size: 18px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

const PageHint = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

const Card = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  overflow: hidden;
`;

const SectionHead = styled.div`
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
`;

const SectionTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const SectionCount = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: right;
`;

const Empty = styled.div`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.lg}`};
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textSubtle};
  text-align: center;
  line-height: 1.5;
`;

// ---- activity controls (range chips + paging + rejections toggle) ----

const ControlsRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`;

const RangeChips = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const RangeChip = styled.button<{ $active: boolean }>`
  padding: ${({ theme }) => `2px ${theme.space.sm}`};
  border: 1px solid
    ${({ theme, $active }) => ($active ? theme.colors.accent : "transparent")};
  border-radius: 999px;
  background: ${({ theme, $active }) =>
    $active ? theme.colors.bgHover : "transparent"};
  font-size: 12px;
  font-weight: ${({ $active }) => ($active ? 600 : 500)};
  color: ${({ theme, $active }) =>
    $active ? theme.colors.text : theme.colors.textMuted};
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const PageArrow = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 999px;
  background: transparent;
  font-size: 14px;
  line-height: 1;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.bgHover};
    color: ${({ theme }) => theme.colors.text};
  }
  &:disabled {
    opacity: 0.3;
    cursor: default;
  }
`;

const ToggleLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  user-select: none;
  input {
    cursor: pointer;
    accent-color: ${({ theme }) => theme.colors.accent};
  }
`;

const CutoffSelect = styled.select`
  font: inherit;
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgPanel};
  color: ${({ theme }) => theme.colors.text};
  cursor: pointer;
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

// ---- heatmap ----

const GridScroll = styled.div`
  overflow-x: auto;
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.lg} ${theme.space.md}`};
`;

const Grid = styled.div`
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
`;

const CELL = "11px";
const GAP = "3px";

const WeekdaySpacer = styled.div`
  width: 26px;
  flex-shrink: 0;
`;

const MonthsRow = styled.div`
  display: flex;
  gap: ${GAP};
  height: 12px;
`;

const MonthSlot = styled.div`
  width: ${CELL};
  flex-shrink: 0;
  font-size: 9px;
  color: ${({ theme }) => theme.colors.textSubtle};
  white-space: nowrap;
  overflow: visible;
`;

const GridBody = styled.div`
  display: flex;
  gap: ${GAP};
`;

const WeekdayCol = styled.div`
  width: 26px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: ${GAP};
`;

const WeekdayLabel = styled.div`
  height: ${CELL};
  font-size: 9px;
  line-height: ${CELL};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const Weeks = styled.div`
  display: flex;
  gap: ${GAP};
`;

const WeekCol = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${GAP};
`;

const Cell = styled.div<{ $level: number; $future?: boolean }>`
  width: ${CELL};
  height: ${CELL};
  border-radius: 2px;
  flex-shrink: 0;
  background: ${({ theme, $level }) =>
    $level <= 0
      ? theme.colors.bgMuted
      : `color-mix(in srgb, ${theme.colors.accent} ${levelMix($level)}, transparent)`};
  ${({ $future }) => ($future ? "opacity: 0.25;" : "")}
`;

const LegendRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${GAP};
  margin-top: 6px;
  margin-left: 30px;
`;

const LegendLabel = styled.span`
  font-size: 9px;
  color: ${({ theme }) => theme.colors.textSubtle};
  margin: 0 2px;
`;

// ---- cell tooltip ----

const Tooltip = styled.div`
  position: fixed;
  z-index: 1100;
  transform: translate(-50%, calc(-100% - 8px));
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: 6px 10px;
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
`;

const TipSummary = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const TipDate = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// ---- day list ----

const DayBlock = styled.div`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
`;

const DayHeader = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: 4px;
`;

const DayWhen = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const DayDate = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const DayLine = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  padding: 1px 0;
`;

const Dot = styled.span<{ $color: (t: DefaultTheme) => string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ theme, $color }) => $color(theme)};
`;

// Inline clickable company name → company page.
const CompanyLink = styled.button`
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: ${({ theme }) => theme.colors.accent};
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
`;

const MoreButton = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  background: transparent;
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  text-align: center;
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// ---- funnel ----

const FunnelBody = styled.div`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.lg}`};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
`;

const Bar = styled.div`
  display: flex;
  width: 100%;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  gap: 2px;
  background: ${({ theme }) => theme.colors.bgMuted};
`;

const Seg = styled.div<{
  $color: (t: DefaultTheme) => string;
  $grow: number;
  $dim: boolean;
}>`
  flex-grow: ${({ $grow }) => $grow};
  flex-basis: 0;
  background: ${({ theme, $color }) => $color(theme)};
  opacity: ${({ $dim }) => ($dim ? 0.3 : 1)};
  transition: opacity 0.12s ease;
`;

const Legend = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
`;

const LegendItem = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: ${({ theme }) => `2px ${theme.space.sm}`};
  border: 1px solid
    ${({ theme, $active }) => ($active ? theme.colors.accent : "transparent")};
  border-radius: 999px;
  background: ${({ theme, $active }) => ($active ? theme.colors.bgHover : "transparent")};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const LegendNum = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`;

const SubHint = styled.div`
  font-size: 12px;
  font-style: italic;
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: ${({ theme }) => `${theme.space.xs} 0`};
`;

// ---- applications list ----

const ListHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.sm};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  padding-top: ${({ theme }) => theme.space.sm};
`;

const ListLabel = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.sm};
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const ListCount = styled.span`
  font-size: 11px;
  font-weight: 500;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
`;

const FilterTag = styled.span`
  font-size: 11px;
  font-weight: 500;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
`;

const ClearBtn = styled.button`
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.accent};
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
`;

const AppRows = styled.div`
  display: flex;
  flex-direction: column;
`;

const AppRow = styled.div`
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  align-items: center;
  padding: ${({ theme }) => `${theme.space.sm} 0`};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const AppMain = styled.div`
  min-width: 0;
`;

const AppTitle = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const AppCompany = styled.button`
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: ${({ theme }) => theme.colors.accent};
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
`;

const AppCompanyText = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const StatusPill = styled.span<{ $status: string }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 7px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status }) => statusColor(theme, $status)};
  white-space: nowrap;
  flex-shrink: 0;
`;
