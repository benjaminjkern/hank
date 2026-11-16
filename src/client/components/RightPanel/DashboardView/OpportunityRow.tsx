import styled from "styled-components";

import type { DashboardOpportunity } from "@/client/chatStore";
import {
  appliedTierBadge,
  closedActionLabel,
  statusLabel,
} from "@/shared/statusColors";
import { fullDateTime, relativeTime } from "@/shared/utils/date";
import { nowMs } from "@/shared/utils/now";

import { ShowMoreToggle } from "../shared/ShowMoreToggle";
import { useExpandable } from "../shared/useExpandable";

import {
  DASHBOARD_PREVIEW_COUNT,
  EmptyRow,
  Group,
  GroupCount,
  RowMain,
  StatusPill,
} from "./sharedStyles";

// Opportunity group header: lead label on top, contact attribution + next-step
// timing on a sub-line. Mirrors the Company GroupHeader shape so the user's
// eye reads both sections the same way.
const OppGroupHeader = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: ${({ theme }) => theme.space.sm};
  row-gap: 2px;
  align-items: center;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
  text-align: left;
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Top row of the opportunity header: label + status pill inline, mirroring
// the company header (logo + name + status). min-width: 0 keeps a long label
// from shoving the pill out.
const OppGroupLabelRow = styled.div`
  grid-row: 1;
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const OppGroupLabel = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const OppGroupMeta = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  grid-row: 2;
  grid-column: 1;
`;

// "N in pipeline" count in the top-right of the opportunity header, spanning
// both rows so it sits centered like the company header's count.
const OppGroupCount = styled(GroupCount)`
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
`;

// One role row inside an opportunity group. Three columns: title (+ optional
// company), status pill, optional "applied" badge. Click navigates to the
// promoted JobInteraction if there is one, otherwise opens the lead.
const RoleRow = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: ${({ theme }) => theme.space.md};
  align-items: center;
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

// Mute closed/rejected jobs so the row count doesn't dominate the visual
// weight of leads where most pitches turned out to be passes.
const MutedRoleRow = styled(RoleRow)`
  opacity: 0.55;
`;

const RoleTitle = styled.div`
  color: ${({ theme }) => theme.colors.text};
`;

const RoleSubLine = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 1px;
`;

const RolePills = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`;

export function OpportunityRow({
  opportunity,
  onPickLead,
  onPickJob,
}: {
  opportunity: DashboardOpportunity;
  onPickLead: () => void;
  onPickJob: (jobId: string) => void;
}) {
  const metaParts: string[] = [];
  if (opportunity.primaryContact) {
    const name = opportunity.primaryContact.name;
    metaParts.push(
      `via ${name}${opportunity.primaryContact.agency ? ` (${opportunity.primaryContact.agency})` : ""}`,
    );
  }
  if (opportunity.nextStepAt) {
    metaParts.push(`next: ${fullDateTime(opportunity.nextStepAt)}`);
  } else if (opportunity.status === "OPEN") {
    metaParts.push("no call scheduled");
  }

  const jobs = opportunity.jobs ?? [];
  const now = nowMs();
  const jobList = useExpandable(jobs, DASHBOARD_PREVIEW_COUNT);

  return (
    <Group>
      <OppGroupHeader onClick={onPickLead}>
        <OppGroupLabelRow>
          <OppGroupLabel>{opportunity.label}</OppGroupLabel>
          <StatusPill $status={opportunity.status}>
            {statusLabel(opportunity.status)}
          </StatusPill>
        </OppGroupLabelRow>
        {metaParts.length > 0 && (
          <OppGroupMeta>{metaParts.join(" · ")}</OppGroupMeta>
        )}
        {jobs.length > 0 && (
          <OppGroupCount>{jobs.length} in pipeline</OppGroupCount>
        )}
      </OppGroupHeader>
      {jobs.length === 0 ? (
        <EmptyRow>no roles pitched yet</EmptyRow>
      ) : (
        <>
          {jobList.visible.map((j) => {
            const muted = j.status === "CLOSED" || j.status === "REJECTED";
            const RowComponent = muted ? MutedRoleRow : RoleRow;
            const timingCaption =
              j.status === "APPLIED" && j.appliedAt
                ? `Applied ${relativeTime(j.appliedAt)}`
                : j.closedAt
                  ? `${closedActionLabel(j.status, null)} ${relativeTime(j.closedAt)}`
                  : null;
            const subParts = [
              j.companyDisplayName ? `@ ${j.companyDisplayName}` : null,
              timingCaption,
            ].filter(Boolean);
            return (
              <RowComponent
                key={j.jobInteractionId}
                onClick={() => onPickJob(j.jobId)}
              >
                <RowMain>
                  <RoleTitle>{j.title}</RoleTitle>
                  {subParts.length > 0 && (
                    <RoleSubLine>{subParts.join(" · ")}</RoleSubLine>
                  )}
                </RowMain>
                <RolePills>
                  <StatusPill
                    $status={j.status}
                    $appliedAt={j.appliedAt}
                    $now={now}
                  >
                    {statusLabel(j.status)}
                    {appliedTierBadge(j.appliedAt, now)}
                  </StatusPill>
                </RolePills>
              </RowComponent>
            );
          })}
          <ShowMoreToggle expandable={jobList} />
        </>
      )}
    </Group>
  );
}
