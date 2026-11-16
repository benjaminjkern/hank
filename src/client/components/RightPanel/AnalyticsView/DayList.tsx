"use client";

import styled from "styled-components";

import type { Advancement } from "@/server/views/analytics";
import { fullDate, relativeTime } from "@/shared/utils/date";

import { ShowMoreToggle } from "../shared/ShowMoreToggle";
import { useExpandable } from "../shared/useExpandable";

import { categoryColor, groupDay } from "./advancements";
import { Dot } from "./styles";

export function DayList({
  groups,
  onPickCompany,
}: {
  groups: { key: string; items: Advancement[]; latest: string }[];
  onPickCompany: (companyId: string) => void;
}) {
  const dayList = useExpandable(groups, 10);
  return (
    <>
      {dayList.visible.map((g) => (
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
      <ShowMoreToggle expandable={dayList} noun={["day", "days"]} topBorder />
    </>
  );
}

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
