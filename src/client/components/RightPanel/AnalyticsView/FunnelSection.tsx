"use client";

import { useMemo, useState } from "react";
import styled, { type DefaultTheme } from "styled-components";

import { useChatStore } from "@/client/chatStore";
import { nowMs } from "@/shared/utils/now";
import type { Application, FunnelBucket } from "@/shared/views/analytics";

import { AppList } from "./AppList";
import {
  CATEGORIES,
  CUTOFFS,
  DEFAULT_CUTOFF_MONTHS,
  appCompanyLabel,
  catColor,
  type CatKey,
} from "./funnel";
import {
  Card,
  ControlsRow,
  Dot,
  Empty,
  SectionCount,
  SectionHead,
  SectionTitle,
} from "./styles";

// Approximate heights used to reserve the list's min-height so filtering
// doesn't shrink the panel (see `reservedMinHeight`). Deliberately a hair taller
// than the real rows so the tallest collapsed state is always covered.
const RESERVE_ROW_H = 52; // px ≈ one application row (title + company + padding)
const RESERVE_MORE_H = 40; // px ≈ the "Show N more" button row

// Funnel: merged bar + clickable category filters + job list.
export function FunnelSection({
  applications,
}: {
  applications: Application[];
}) {
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
            <CutoffLabel>
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
            </CutoffLabel>
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

const CutoffLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  user-select: none;
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

// ---- bar + legend ----

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

// ---- applications list header ----

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
