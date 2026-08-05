"use client";

import styled from "styled-components";

import { useChatStore, type PanelMode } from "@/lib/chatStore";

// Narrow-only tab switcher between Chat and the right panel. Styled as an
// iOS-style segmented pill: one rounded container with a filled "active"
// inset and a transparent inactive segment. The bar itself just centers the
// pill and carries the bottom divider that separates it from the panes.
const Bar = styled.div`
  display: none;

  @media (max-width: ${({ theme }) => theme.breakpoints.narrow}) {
    display: flex;
    justify-content: center;
    padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    background: ${({ theme }) => theme.colors.bgPanel};
  }
`;

const Pill = styled.div`
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: 999px;
  width: min(360px, 100%);
`;

const Segment = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.space.xs};
  min-height: 30px;
  padding: 0 ${({ theme }) => theme.space.md};
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme, $active }) =>
    $active ? theme.colors.text : theme.colors.textMuted};
  background: ${({ theme, $active }) =>
    $active ? theme.colors.bgPanel : "transparent"};
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
  box-shadow: ${({ $active }) =>
    $active ? "0 1px 2px rgba(0, 0, 0, 0.18)" : "none"};

  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const Label = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
`;

const Dot = styled.span`
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.accent};
  flex-shrink: 0;
`;

export function PanelTabs() {
  const activePanel = useChatStore((s) => s.activePanel);
  const setActivePanel = useChatStore((s) => s.setActivePanel);
  const panelBadge = useChatStore((s) => s.panelBadge);
  const panelMode = useChatStore((s) => s.panelMode);
  const viewedCompany = useChatStore((s) => s.viewedCompany);
  const viewedJob = useChatStore((s) => s.viewedJob);
  const viewedOpportunity = useChatStore((s) => s.viewedOpportunity);

  const rightLabel = rightTabLabel({
    panelMode,
    companyName: viewedCompany?.name ?? null,
    jobTitle: viewedJob?.title ?? null,
    opportunityLabel: viewedOpportunity?.label ?? null,
  });

  return (
    <Bar>
      <Pill role="tablist" aria-label="Panel">
        <Segment
          role="tab"
          aria-selected={activePanel === "chat"}
          $active={activePanel === "chat"}
          onClick={() => setActivePanel("chat")}
        >
          <Label>Chat</Label>
        </Segment>
        <Segment
          role="tab"
          aria-selected={activePanel === "right"}
          $active={activePanel === "right"}
          onClick={() => setActivePanel("right")}
        >
          <Label>{rightLabel}</Label>
          {panelBadge && activePanel !== "right" && (
            <Dot aria-label="Updated" />
          )}
        </Segment>
      </Pill>
    </Bar>
  );
}

function rightTabLabel(args: {
  panelMode: PanelMode;
  companyName: string | null;
  jobTitle: string | null;
  opportunityLabel: string | null;
}): string {
  switch (args.panelMode) {
    case "dashboard":
      return "Dashboard";
    case "documents":
      return "Documents";
    case "analytics":
      return "Analytics";
    case "company-context":
      return args.companyName ?? "Company";
    case "job-detail":
      return args.jobTitle ?? "Job";
    case "opportunity-detail":
      return args.opportunityLabel ?? "Opportunity";
    case "shortlist-board":
      return "Shortlist";
    case "application":
      return "Application";
  }
}
