"use client";

import { useEffect, useState } from "react";
import styled from "styled-components";

import { ClientErrorBoundary } from "@/components/ClientErrorBoundary";
import { useChatStore } from "@/lib/chatStore";

import { AnalyticsView } from "./AnalyticsView";
import { ApplicationView } from "./ApplicationView";
import { Breadcrumbs } from "./Breadcrumbs";
import { CompanyContextView } from "./CompanyContextView";
import { DashboardView } from "./DashboardView";
import { DocumentsView } from "./DocumentsView";
import { JobDetailView } from "./JobDetailView";
import { OpportunityDetailView } from "./OpportunityDetailView";
import { ShortlistBoardView } from "./ShortlistBoardView";

// Mirrors theme.breakpoints.narrow — inlined because matchMedia runs outside
// React render. Keep in sync with the same constant in SplitLayout.tsx.
const NARROW_MAX_WIDTH = "900px";

function useIsNarrow() {
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH})`);
    setIsNarrow(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return isNarrow;
}

const Root = styled.div`
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
`;

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  min-height: ${({ theme }) => theme.size.topBar};
`;

const BarBreadcrumbs = styled.div`
  flex: 1;
  min-width: 0;
  // Breadcrumbs ships its own margin-bottom — neutralize it inside the bar.
  & > nav {
    margin-bottom: 0;
  }
`;

const Toggle = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: ${({ theme }) => theme.colors.textMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 14px;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
    background: ${({ theme }) => theme.colors.bgHover};
  }

  // Tab bar replaces this on narrow viewports; collapsing the right pane
  // there doesn't make sense (it's already the only thing visible).
  @media (max-width: ${({ theme }) => theme.breakpoints.narrow}) {
    display: none;
  }
`;

const Content = styled.div`
  padding: ${({ theme }) => theme.space.xl};
  overflow-y: auto;
`;

const Empty = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-size: 14px;
  text-align: center;
  max-width: 360px;
  margin: 0 auto;
  line-height: 1.5;
`;

// Reserve the same topBar-height header zone as the expanded Bar so the toggle
// sits at the same vertical position whether collapsed or expanded. Horizontal
// position can't perfectly match (the expanded toggle hugs the right edge of
// a wide bar; the collapsed strip is only 32px wide), so center horizontally
// in the strip — that reads as deliberate, whereas right-pinning made the
// button look glued to the right border.
const Strip = styled.div`
  display: grid;
  grid-template-rows: ${({ theme }) => theme.size.topBar} 1fr;
  justify-items: center;
  align-items: center;
  height: 100%;
`;

export function RightPanel() {
  const panelMode = useChatStore((s) => s.panelMode);
  const viewedCompany = useChatStore((s) => s.viewedCompany);
  const viewedJob = useChatStore((s) => s.viewedJob);
  const viewedOpportunity = useChatStore((s) => s.viewedOpportunity);
  const viewedBoard = useChatStore((s) => s.viewedBoard);
  const viewedApplication = useChatStore((s) => s.viewedApplication);
  const documentsSubPage = useChatStore((s) => s.documentsNav.subPage);
  const dashboard = useChatStore((s) => s.dashboard);
  const collapsed = useChatStore((s) => s.rightCollapsed);
  const toggle = useChatStore((s) => s.toggleRightCollapsed);
  const isNarrow = useIsNarrow();

  // Collapsed state is a wide-viewport affordance — on narrow the tab bar
  // takes over and the Toggle is hidden. Rendering the Strip there would
  // leave the dashboard tab visually empty (no toggle to expand, no content),
  // which is what users see on a fresh session before anything's surfaced.
  if (collapsed && !isNarrow) {
    return (
      <Strip>
        <Toggle onClick={toggle} title="Expand panel">
          ‹
        </Toggle>
      </Strip>
    );
  }

  const body =
    panelMode === "job-detail" && viewedJob ? (
      <JobDetailView job={viewedJob} />
    ) : panelMode === "opportunity-detail" && viewedOpportunity ? (
      <OpportunityDetailView opportunity={viewedOpportunity} />
    ) : panelMode === "company-context" && viewedCompany ? (
      <CompanyContextView company={viewedCompany} />
    ) : panelMode === "shortlist-board" && viewedBoard ? (
      <ShortlistBoardView board={viewedBoard} />
    ) : panelMode === "application" && viewedApplication ? (
      <ApplicationView application={viewedApplication} />
    ) : panelMode === "documents" ? (
      <DocumentsView />
    ) : panelMode === "analytics" ? (
      <AnalyticsView />
    ) : panelMode === "dashboard" && dashboard ? (
      <DashboardView data={dashboard} />
    ) : (
      <Empty>No applications yet — open chat and ask Hank to find jobs.</Empty>
    );

  // Breadcrumbs reflect what the panel is currently *viewing*, not Hank's
  // focus, and they're the shape the URL mirrors (see src/lib/panelUrl.ts).
  // The three branches below cover documents / analytics / shortlist-board /
  // application; this block builds the remaining ones:
  //   dashboard           — no crumbs
  //   company-context     — Dashboard / <CompanyName>
  //   job-detail (w/ co)  — Dashboard / <CompanyName> / <JobTitle>
  //   job-detail (no co)  — Dashboard / <unaffiliated> / <JobTitle>
  //   opportunity-detail  — Dashboard / <OpportunityLabel>
  const crumbCompany =
    panelMode === "job-detail" && viewedJob?.company
      ? { id: viewedJob.company.id, name: viewedJob.company.name }
      : panelMode === "company-context" && viewedCompany
        ? { id: viewedCompany.id, name: viewedCompany.name }
        : undefined;
  const crumbJobTitle =
    panelMode === "job-detail" && viewedJob ? viewedJob.title : undefined;
  const crumbOpportunity =
    panelMode === "opportunity-detail" && viewedOpportunity
      ? { id: viewedOpportunity.id, label: viewedOpportunity.label }
      : undefined;
  const crumbUnaffiliatedJob =
    panelMode === "job-detail" && viewedJob !== null && !viewedJob?.company;

  const showCrumbs =
    panelMode !== "dashboard" &&
    (crumbCompany ||
      crumbOpportunity ||
      (crumbUnaffiliatedJob && crumbJobTitle));

  return (
    <Root>
      <Bar>
        <BarBreadcrumbs>
          {panelMode === "documents" ? (
            <Breadcrumbs documents documentsSubPage={documentsSubPage} />
          ) : panelMode === "analytics" ? (
            <Breadcrumbs analytics />
          ) : panelMode === "shortlist-board" && viewedBoard ? (
            <Breadcrumbs
              shortlistBoard={{
                id: viewedBoard.companyId,
                name: viewedBoard.companyName,
              }}
            />
          ) : panelMode === "application" && viewedApplication ? (
            <Breadcrumbs
              company={viewedApplication.company ?? undefined}
              jobTitle={viewedApplication.jobTitle}
              jobId={viewedApplication.jobId}
              application
            />
          ) : (
            showCrumbs && (
              <Breadcrumbs
                company={crumbCompany}
                jobTitle={crumbJobTitle}
                opportunity={crumbOpportunity}
                unaffiliatedJob={crumbUnaffiliatedJob}
              />
            )
          )}
        </BarBreadcrumbs>
        <Toggle onClick={toggle} title="Collapse panel">
          ›
        </Toggle>
      </Bar>
      <Content>
        <ClientErrorBoundary
          component="RightPanel"
          fallback={
            <Empty>
              This panel ran into a display error. Reopen it from chat to try
              again.
            </Empty>
          }
        >
          {body}
        </ClientErrorBoundary>
      </Content>
    </Root>
  );
}
