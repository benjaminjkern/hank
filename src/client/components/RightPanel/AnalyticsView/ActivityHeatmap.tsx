"use client";

import styled from "styled-components";

import { fullDate } from "@/shared/utils/date";

import { cellLevel, levelMix, type Week } from "./heatmap";

export type HoverTip = {
  left: number;
  top: number;
  date: string;
  summary: string;
};

// The GitHub-style day grid: month labels across the top, weekday labels down
// the side, one cell per day, and the Less → More legend. Hovering a non-empty
// past day reports the tooltip for the parent section to render.
export function ActivityHeatmap({
  weeks,
  summaryByDay,
  onHover,
}: {
  weeks: Week[];
  summaryByDay: Map<string, string>;
  onHover: (tip: HoverTip | null) => void;
}) {
  return (
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
                      onHover({
                        left: r.left + r.width / 2,
                        top: r.top,
                        date: fullDate(d.date),
                        summary: summaryByDay.get(d.key) ?? "",
                      });
                    }}
                    onMouseLeave={() => onHover(null)}
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
  );
}

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
