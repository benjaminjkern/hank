"use client";

import styled from "styled-components";

import type { Application } from "@/server/views/analytics";
import { statusColor, statusLabel } from "@/shared/statusColors";

import { useExpandable } from "../shared/useExpandable";

import { MoreButton } from "./styles";

export function AppList({
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

const SubHint = styled.div`
  font-size: 12px;
  font-style: italic;
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: ${({ theme }) => `${theme.space.xs} 0`};
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
