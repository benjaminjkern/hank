"use client";

import { useMemo, useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/client/chatStore";
import type { Advancement } from "@/server/views/analytics";
import { dayKey } from "@/shared/utils/date";
import { nowMs } from "@/shared/utils/now";

import { ActivityHeatmap, type HoverTip } from "./ActivityHeatmap";
import { categorySummary } from "./advancements";
import { DayList } from "./DayList";
import { QUARTER_WEEKS, RANGES, buildWeeks } from "./heatmap";
import {
  Card,
  ControlsRow,
  Empty,
  SectionCount,
  SectionHead,
  SectionTitle,
  ToggleLabel,
} from "./styles";

// Activity: heatmap + per-day list.
export function ActivitySection({
  advancements,
}: {
  advancements: Advancement[];
}) {
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

      <ActivityHeatmap
        weeks={weeks}
        summaryByDay={summaryByDay}
        onHover={setTip}
      />

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

// ---- range chips + paging ----

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
