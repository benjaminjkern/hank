"use client";

import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import { documentsSubPageLabel, type DocumentsSubPage } from "@/lib/panelMode";

const Nav = styled.nav`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs};
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-bottom: ${({ theme }) => theme.space.lg};
`;

const Crumb = styled.button`
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  padding: 2px 4px;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const Current = styled.span`
  color: ${({ theme }) => theme.colors.text};
  padding: 2px 4px;
`;

// Non-navigable placeholder shown in the company slot when a Job has no
// parent Company (agency-pitched roles whose hiring company isn't on the
// watchlist yet). Visually dimmed + italic to signal "missing", and
// deliberately not a button — clicking it goes nowhere because there's no
// destination, which is honest. A reader can tell at a glance that the
// breadcrumb's middle node represents an absence, not a real entity.
const UnaffiliatedSlot = styled.span`
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: 2px 4px;
  font-style: italic;
`;

const Sep = styled.span`
  color: ${({ theme }) => theme.colors.textSubtle};
`;

type CompanyCrumb = { id: string; name: string };
type OpportunityCrumb = { id: string; label: string };

export function Breadcrumbs({
  company,
  jobTitle,
  opportunity,
  unaffiliatedJob,
  documents,
  documentsSubPage,
  analytics,
  shortlistBoard,
  jobId,
  application,
}: {
  company?: CompanyCrumb;
  jobTitle?: string;
  // Lead label rendered as `Dashboard / <label>` for opportunity-detail mode.
  // Mutually exclusive with `company` (a lead can span multiple companies, so
  // it doesn't sit under a single company crumb).
  opportunity?: OpportunityCrumb;
  // True for job-detail mode where the job has no parent Company yet. Renders
  // an italic `<unaffiliated>` slot before the job title so the breadcrumb's
  // depth stays consistent and the missing-parent state is visible.
  unaffiliatedJob?: boolean;
  // True for the documents view: `Dashboard / Documents`, plus a third crumb
  // for the open sub-page.
  documents?: boolean;
  documentsSubPage?: DocumentsSubPage;
  // True for the analytics view: `Dashboard / Analytics`.
  analytics?: boolean;
  // Company whose shortlist board is showing: `Dashboard / <Company> / Shortlist`.
  shortlistBoard?: CompanyCrumb;
  // The job an application page belongs to, so its crumb links back to the role.
  jobId?: string;
  // True for the application page: `Dashboard / <Company> / <Role> / Application`.
  application?: boolean;
}) {
  const viewDashboard = useChatStore((s) => s.viewDashboard);
  const setDocumentsSubPage = useChatStore((s) => s.setDocumentsSubPage);
  const viewCompany = useChatStore((s) => s.viewCompany);
  const viewJob = useChatStore((s) => s.viewJob);

  if (application) {
    return (
      <Nav aria-label="Breadcrumb">
        <Crumb onClick={() => viewDashboard()}>Dashboard</Crumb>
        <Sep>/</Sep>
        {company ? (
          <Crumb onClick={() => void viewCompany(company.id)}>
            {company.name}
          </Crumb>
        ) : (
          <UnaffiliatedSlot>&lt;unaffiliated&gt;</UnaffiliatedSlot>
        )}
        <Sep>/</Sep>
        {jobId ? (
          <Crumb onClick={() => void viewJob(jobId)}>{jobTitle}</Crumb>
        ) : (
          <Current>{jobTitle}</Current>
        )}
        <Sep>/</Sep>
        <Current>Application</Current>
      </Nav>
    );
  }

  if (shortlistBoard) {
    return (
      <Nav aria-label="Breadcrumb">
        <Crumb onClick={() => viewDashboard()}>Dashboard</Crumb>
        <Sep>/</Sep>
        <Crumb onClick={() => void viewCompany(shortlistBoard.id)}>
          {shortlistBoard.name}
        </Crumb>
        <Sep>/</Sep>
        <Current>Shortlist</Current>
      </Nav>
    );
  }

  // Documents: `Dashboard / Documents[ / <sub-page>]`. On a sub-page the
  // Documents crumb is what goes back up to the index.
  if (documents) {
    const onSubPage =
      documentsSubPage !== undefined && documentsSubPage !== "index";
    return (
      <Nav aria-label="Breadcrumb">
        <Crumb onClick={() => viewDashboard()}>Dashboard</Crumb>
        <Sep>/</Sep>
        {onSubPage ? (
          <>
            <Crumb onClick={() => setDocumentsSubPage("index")}>
              Documents
            </Crumb>
            <Sep>/</Sep>
            <Current>{documentsSubPageLabel(documentsSubPage)}</Current>
          </>
        ) : (
          <Current>Documents</Current>
        )}
      </Nav>
    );
  }

  // Analytics: `Dashboard / Analytics`. Current node is non-clickable.
  if (analytics) {
    return (
      <Nav aria-label="Breadcrumb">
        <Crumb onClick={() => viewDashboard()}>Dashboard</Crumb>
        <Sep>/</Sep>
        <Current>Analytics</Current>
      </Nav>
    );
  }

  // Opportunity-detail: `Dashboard / <label>`. Label is the current node so
  // it's non-clickable (you're already viewing it).
  if (opportunity) {
    return (
      <Nav aria-label="Breadcrumb">
        <Crumb onClick={() => viewDashboard()}>Dashboard</Crumb>
        <Sep>/</Sep>
        <Current>{opportunity.label}</Current>
      </Nav>
    );
  }

  return (
    <Nav aria-label="Breadcrumb">
      <Crumb onClick={() => viewDashboard()}>Dashboard</Crumb>
      {company && (
        <>
          <Sep>/</Sep>
          {jobTitle ? (
            <Crumb onClick={() => void viewCompany(company.id)}>
              {company.name}
            </Crumb>
          ) : (
            <Current>{company.name}</Current>
          )}
        </>
      )}
      {!company && unaffiliatedJob && jobTitle && (
        <>
          <Sep>/</Sep>
          <UnaffiliatedSlot title="This job has no company attached yet.">
            unaffiliated
          </UnaffiliatedSlot>
        </>
      )}
      {jobTitle && (
        <>
          <Sep>/</Sep>
          <Current>{jobTitle}</Current>
        </>
      )}
    </Nav>
  );
}
