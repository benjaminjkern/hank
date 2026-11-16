import styled from "styled-components";

import { appliedTierBadge, statusLabel } from "@/shared/statusColors";
import { nowMs } from "@/shared/utils/now";

import { CompanyLogoChip } from "../shared/CompanyLogoChip";

import {
  CloseNoteLine,
  CloseReasonLabel,
  ClosedRow,
  ClosedRowLeft,
  ClosedSection,
  StatusPill,
  Title,
} from "./sharedStyles";

import type { SearchResults } from "./buildSearchResults";

// Section heading inside the search-results view ("Companies 3" / "Jobs 5" /
// "Leads 1"). Lighter than a bucket header — results aren't a triage queue,
// just a typed lookup.
const ResultGroupHead = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  margin: ${({ theme }) => `${theme.space.lg} 0 ${theme.space.sm}`};
`;

const ResultGroupTitle = styled.h3`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0;
`;

const ResultGroupCount = styled.span`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// "Track '<name>'" affordance — the add half of the searchbar. Sends a plain
// "add this company" message into chat, which Hank's watchlist-add flow picks
// up (create_companies → enrich_companies). Full-width, accent-tinted so it
// reads as an action distinct from the result rows above it.
const AddNewButton = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  margin-top: ${({ theme }) => theme.space.md};
  border: 1px dashed ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: transparent;
  color: ${({ theme }) => theme.colors.accent};
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
  &:hover {
    background: ${({ theme }) =>
      `color-mix(in srgb, ${theme.colors.accent} 8%, transparent)`};
  }
`;

const AddNewPlus = styled.span`
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
`;

const AddNewQuery = styled.strong`
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`;

const NoResults = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textSubtle};
  text-align: center;
  padding: ${({ theme }) =>
    `${theme.space.lg} ${theme.space.md} ${theme.space.sm}`};
`;

// One flat results view, replacing the bucket layout while a query is active.
// Sections render only when they have hits; the "Track …" affordance is the
// add half — prominent when nothing matched, a quieter footer otherwise.
export function SearchResultsView({
  results,
  query,
  canTrackNew,
  onTrackNew,
  onPickCompany,
  onPickJob,
  onPickLead,
}: {
  results: SearchResults;
  query: string;
  canTrackNew: boolean;
  onTrackNew: () => void;
  onPickCompany: (companyId: string) => void;
  onPickJob: (jobId: string) => void;
  onPickLead: (opportunityId: string) => void;
}) {
  const { companies, jobs, leads, total } = results;
  const now = nowMs();
  return (
    <ClosedSection>
      {total === 0 && (
        <NoResults>No companies, jobs, or leads match “{query}”.</NoResults>
      )}

      {companies.length > 0 && (
        <>
          <ResultGroupHead>
            <ResultGroupTitle>Companies</ResultGroupTitle>
            <ResultGroupCount>{companies.length}</ResultGroupCount>
          </ResultGroupHead>
          {companies.map((c) => (
            <ClosedRow
              key={c.companyId}
              onClick={() => onPickCompany(c.companyId)}
            >
              <ClosedRowLeft>
                <CompanyLogoChip
                  logoUrl={c.logoUrl}
                  name={c.companyName}
                  size={20}
                />
                <Title>{c.companyName}</Title>
              </ClosedRowLeft>
              <CloseReasonLabel>{c.stateLabel}</CloseReasonLabel>
            </ClosedRow>
          ))}
        </>
      )}

      {jobs.length > 0 && (
        <>
          <ResultGroupHead>
            <ResultGroupTitle>Jobs</ResultGroupTitle>
            <ResultGroupCount>{jobs.length}</ResultGroupCount>
          </ResultGroupHead>
          {jobs.map((j) => {
            const sub = [j.companyName, j.meta].filter(Boolean).join(" · ");
            return (
              <ClosedRow key={j.jobId} onClick={() => onPickJob(j.jobId)}>
                <ClosedRowLeft>
                  <div>
                    <Title>{j.title}</Title>
                    {sub && <CloseNoteLine>{sub}</CloseNoteLine>}
                  </div>
                </ClosedRowLeft>
                <StatusPill
                  $status={j.status}
                  $appliedAt={j.appliedAt}
                  $now={now}
                >
                  {statusLabel(j.status)}
                  {appliedTierBadge(j.appliedAt, now)}
                </StatusPill>
              </ClosedRow>
            );
          })}
        </>
      )}

      {leads.length > 0 && (
        <>
          <ResultGroupHead>
            <ResultGroupTitle>Leads</ResultGroupTitle>
            <ResultGroupCount>{leads.length}</ResultGroupCount>
          </ResultGroupHead>
          {leads.map((l) => (
            <ClosedRow
              key={l.opportunityId}
              onClick={() => onPickLead(l.opportunityId)}
            >
              <ClosedRowLeft>
                <Title>{l.label}</Title>
              </ClosedRowLeft>
              <StatusPill $status={l.status}>
                {statusLabel(l.status)}
              </StatusPill>
            </ClosedRow>
          ))}
        </>
      )}

      {canTrackNew && (
        <AddNewButton type="button" onClick={onTrackNew}>
          <AddNewPlus>+</AddNewPlus>
          <span>
            Track <AddNewQuery>“{query}”</AddNewQuery> as a new company
          </span>
        </AddNewButton>
      )}
    </ClosedSection>
  );
}
