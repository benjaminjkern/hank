import styled from "styled-components";

import type { DashboardCompany } from "@/client/chatStore";
import { appliedTierBadge } from "@/shared/statusColors";
import { relativeTime } from "@/shared/utils/date";
import { nowMs } from "@/shared/utils/now";

import { useExpandable } from "../shared/useExpandable";

import { CompanyLogoChip } from "./CompanyLogoChip";
import {
  DASHBOARD_PREVIEW_COUNT,
  EmptyRow,
  Group,
  GroupCount,
  MoreButton,
  RowMain,
  StatusPill,
  Title,
} from "./sharedStyles";

const GroupHeader = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const GroupHeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const GroupName = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Row = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  align-items: baseline;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 3px solid transparent;
  font-size: 13px;
  text-align: left;
  background: transparent;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }

  &:last-child {
    border-bottom: none;
  }
`;

// Bullet-separated parsed metadata under the job title — location · comp ·
// employment type · department. Mirrors JobDetailView's MetaLine; only the
// fields the scraper actually pulled render (all four are nullable).
const JobMeta = styled.div`
  margin-top: 2px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

function emptyHintFor(c: DashboardCompany): string {
  // Defensive: SHORTLISTED commits auto-bump → APPLYING, so an APPLYING company
  // with zero in-pipeline jobs only happens if everything closed out without
  // an explicit move to CAUGHT_UP. Scrape info isn't useful here — the user
  // needs a status transition.
  if (c.status === "APPLYING") {
    return "all jobs closed — needs a caught-up check";
  }
  if (!c.lastScrapedJobsAt) {
    return "not yet scraped";
  }
  const when = relativeTime(c.lastScrapedJobsAt);
  const n = c.recentJobCount;
  const jobsWord = n === 1 ? "job" : "jobs";
  if (c.status === "READY") {
    // PRE_SCAN finished with survivors but the walkthrough hasn't started.
    return n === 0
      ? `scraped ${when} — ready to walk through`
      : `${n} ${jobsWord} scraped ${when} — ready to walk through`;
  }
  if (c.status === "NEW") {
    // Either scraped but no PRE_SCAN survivors landed yet (cold-start path),
    // or scrape returned zero. Distinguish from READY by absence of survivors.
    return n === 0
      ? `scraped ${when} — no jobs found`
      : `${n} ${jobsWord} scraped ${when} — shortlist pending`;
  }
  // CAUGHT_UP: worked through everything posted.
  return n === 0
    ? `scraped ${when} — no jobs found`
    : `${n} ${jobsWord} reviewed · last scrape ${when}`;
}

// One company box in a live bucket: header (logo + name + status + "N in
// pipeline" count) over its job rows, capped at DASHBOARD_PREVIEW_COUNT with
// a "+N more" toggle. Extracted from the bucket render so it can own the
// expand state (hooks can't live in a .map callback).
export function CompanyGroup({
  company: c,
  onPickCompany,
  onPickJob,
}: {
  company: DashboardCompany;
  onPickCompany: () => void;
  onPickJob: (jobId: string) => void;
}) {
  const jobs = c.jobInteractions;
  const now = nowMs();
  const {
    visible: visibleJobs,
    truncated,
    canCollapse,
    hiddenCount,
    expand,
    collapse,
  } = useExpandable(jobs, DASHBOARD_PREVIEW_COUNT);

  return (
    <Group>
      <GroupHeader onClick={onPickCompany}>
        <GroupHeaderLeft>
          <CompanyLogoChip logoUrl={c.logoUrl} name={c.companyName} />
          <GroupName>{c.companyName}</GroupName>
          <StatusPill $status={c.status}>{c.status}</StatusPill>
        </GroupHeaderLeft>
        {jobs.length > 0 && (
          <GroupCount>
            {jobs.length} in pipeline
            {c.lastScrapedJobsAt &&
              ` · Scraped ${relativeTime(c.lastScrapedJobsAt)}`}
          </GroupCount>
        )}
      </GroupHeader>
      {jobs.length === 0 ? (
        <EmptyRow>{emptyHintFor(c)}</EmptyRow>
      ) : (
        <>
          {visibleJobs.map((i) => {
            // For an applied job, lead the meta with when it went out so the
            // user sees the wait at a glance (the pill color escalates with it).
            const appliedCaption =
              i.status === "APPLIED" && i.appliedAt
                ? `Applied ${relativeTime(i.appliedAt)}`
                : null;
            const meta = [
              appliedCaption,
              i.location,
              i.compensation,
              i.employmentType,
              i.department,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Row key={i.jobInteractionId} onClick={() => onPickJob(i.jobId)}>
                <RowMain>
                  <Title>{i.title}</Title>
                  {meta && <JobMeta>{meta}</JobMeta>}
                </RowMain>
                <StatusPill
                  $status={i.status}
                  $appliedAt={i.appliedAt}
                  $now={now}
                >
                  {i.status}
                  {appliedTierBadge(i.appliedAt, now)}
                </StatusPill>
              </Row>
            );
          })}
          {truncated ? (
            <MoreButton onClick={expand}>+{hiddenCount} more</MoreButton>
          ) : canCollapse ? (
            <MoreButton onClick={collapse}>Collapse</MoreButton>
          ) : null}
        </>
      )}
    </Group>
  );
}
