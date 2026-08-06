"use client";

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import {
  statusLabel,
  jobStatusColor,
  closedActionLabel,
  appliedTierBadge,
} from "@/lib/statusColors";
import type {
  FocusedOpportunityView,
  OpportunityJobView,
} from "@/server/agent/tools/lib/types";
import { relativeTime } from "@/utils/date";
import { nowMs } from "@/utils/now";

import { ContactCard } from "./shared/ContactCard";
import {
  RecentActivity,
  type RecentActivityItem,
} from "./shared/RecentActivity";

const Card = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  overflow: hidden;
`;

const Header = styled.div`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const TopRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: ${({ theme }) => theme.space.md};
`;

const Title = styled.h2`
  font-size: 16px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

const SubLine = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

// `$appliedAt` + `$now` only flow in for the role pill on an APPLIED job;
// without them jobStatusColor falls back to the plain tone, so the lead-status
// pill routes through it unchanged.
const StatusPill = styled.span<{
  $status: string;
  $appliedAt?: string | null;
  $now?: number;
}>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status, $appliedAt, $now }) =>
    jobStatusColor(theme, $status, $appliedAt, $now)};
  white-space: nowrap;
`;

const Section = styled.section`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  &:last-child {
    border-bottom: none;
  }
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const CompanyLink = styled.button`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const Notes = styled.div`
  white-space: pre-wrap;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.5;
`;

const Hint = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
`;

// Roles card: each pitched/discussed role in the lead. Status pill on the
// right; title + company display name on the left. Horizontal padding (and
// rounded corners on hover) keeps the hover background from running flush
// to the row's content edges — mirrors the spacing used in CompanyContextView
// job rows.
const RoleCard = styled.button`
  width: 100%;
  text-align: left;
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: ${({ theme }) => theme.space.md};
  align-items: center;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  border-radius: ${({ theme }) => theme.radius.md};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  background: transparent;
  cursor: pointer;
  &:last-child {
    border-bottom: none;
  }
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Toggle button for the skipped-jobs section, mirroring the dashboard /
// CompanyContextView style.
const ClosedToggle = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  background: transparent;
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  margin-top: ${({ theme }) => theme.space.sm};
  &:hover {
    color: ${({ theme }) => theme.colors.text};
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const ClosedSection = styled.div`
  margin-top: ${({ theme }) => theme.space.sm};
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0.7;
`;

const CloseReasonChip = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  padding: 2px 6px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  white-space: nowrap;
`;

const CloseNoteLine = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-top: 2px;
`;

const RoleTitleLine = styled.div`
  font-size: 14px;
  font-weight: 500;
  color: ${({ theme }) => theme.colors.text};
`;

const RoleSub = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 2px;
`;

const RolePills = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`;

function formatScheduled(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function OpportunityDetailView({
  opportunity,
}: {
  opportunity: FocusedOpportunityView;
}) {
  const viewJob = useChatStore((s) => s.viewJob);

  const additionalContacts = opportunity.primaryContact
    ? opportunity.contacts.filter(
        (c) => c.id !== opportunity.primaryContact!.id,
      )
    : opportunity.contacts;

  // Bucket the linked jobs the same way the company-page does: live roles
  // (PITCHED / NEW / SCANNED / SHORTLISTED / APPLIED → OFFERED) stay in the
  // main list; CLOSED + REJECTED move to a collapsible section below so
  // declined roles don't dominate the visual weight.
  const pipelineJobs: OpportunityJobView[] = [];
  const skippedJobs: OpportunityJobView[] = [];
  for (const ji of opportunity.jobInteractions) {
    if (ji.status === "CLOSED" || ji.status === "REJECTED") {
      skippedJobs.push(ji);
    } else {
      pipelineJobs.push(ji);
    }
  }

  return (
    <Card>
      <Header>
        <TopRow>
          <Title>{opportunity.label}</Title>
          <StatusPill $status={opportunity.status}>
            {statusLabel(opportunity.status)}
          </StatusPill>
        </TopRow>
        {opportunity.nextStepAt && opportunity.status !== "CLOSED" && (
          <SubLine>Next: {formatScheduled(opportunity.nextStepAt)}</SubLine>
        )}
        {opportunity.sourceJobInteraction && (
          <SubLine>
            Spawned from your application to{" "}
            <CompanyLink
              onClick={() =>
                void viewJob(opportunity.sourceJobInteraction!.jobId)
              }
            >
              {opportunity.sourceJobInteraction.title} @{" "}
              {opportunity.sourceJobInteraction.companyName ?? "(no company)"}
            </CompanyLink>
          </SubLine>
        )}
        {opportunity.status === "CLOSED" && opportunity.closedReason && (
          <SubLine>Closed — {opportunity.closedReason}</SubLine>
        )}
      </Header>

      {opportunity.primaryContact && (
        <Section>
          <SectionLabel>Primary contact</SectionLabel>
          <ContactCard contact={opportunity.primaryContact} />
        </Section>
      )}

      {additionalContacts.length > 0 && (
        <Section>
          <SectionLabel>Other contacts</SectionLabel>
          {additionalContacts.map((c) => (
            <ContactCard key={c.id} contact={c} />
          ))}
        </Section>
      )}

      <Section>
        <SectionLabel>Roles ({pipelineJobs.length})</SectionLabel>
        {pipelineJobs.length === 0 ? (
          <Hint>No roles pitched yet.</Hint>
        ) : (
          pipelineJobs.map((ji) => (
            <JobCardEntry
              key={ji.jobInteractionId}
              job={ji}
              onPickJob={(jobId) => void viewJob(jobId)}
            />
          ))
        )}
        <ClosedJobsSection
          jobs={skippedJobs}
          onPickJob={(jobId) => void viewJob(jobId)}
        />
      </Section>

      {opportunity.notes && (
        <Section>
          <SectionLabel>Notes</SectionLabel>
          <Notes>{opportunity.notes}</Notes>
        </Section>
      )}

      <Section>
        <RecentActivity
          items={opportunity.events.map((e): RecentActivityItem => ({
            id: e.id,
            type: e.type,
            occurredAt: e.occurredAt,
            notes: e.notes,
            context: null,
          }))}
        />
      </Section>
    </Card>
  );
}

// One role inside the lead — a regular JobInteraction with opportunityId set.
// Clicking opens the standard JobDetailView via viewJob(jobId), unifying
// pitched-role triage with the normal job pipeline.
function JobCardEntry({
  job,
  onPickJob,
}: {
  job: OpportunityJobView;
  onPickJob: (jobId: string) => void;
}) {
  const now = nowMs();
  const timingCaption =
    job.status === "APPLIED" && job.appliedAt
      ? `Applied ${relativeTime(job.appliedAt)}`
      : job.closedAt
        ? `${closedActionLabel(job.status, job.closeReason)} ${relativeTime(job.closedAt)}`
        : null;
  const subParts = [
    job.companyName ? `@ ${job.companyName}` : null,
    timingCaption,
  ].filter(Boolean);
  return (
    <RoleCard onClick={() => onPickJob(job.jobId)}>
      <div>
        <RoleTitleLine>{job.title}</RoleTitleLine>
        {subParts.length > 0 && <RoleSub>{subParts.join(" · ")}</RoleSub>}
      </div>
      <RolePills>
        <StatusPill $status={job.status} $appliedAt={job.appliedAt} $now={now}>
          {statusLabel(job.status)}
          {appliedTierBadge(job.appliedAt, now)}
        </StatusPill>
      </RolePills>
    </RoleCard>
  );
}

// Collapsible section listing declined/closed roles inside the lead. Mirrors
// CompanyContextView's "Show skipped" pattern: hidden by default, surfaces
// the closeReason chip on each row, and explains *why* via closeNote when set.
function ClosedJobsSection({
  jobs,
  onPickJob,
}: {
  jobs: OpportunityJobView[];
  onPickJob: (jobId: string) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  if (jobs.length === 0) return null;
  return (
    <>
      <ClosedToggle onClick={() => setShowClosed((s) => !s)}>
        {showClosed ? "Hide" : "Show"} closed ({jobs.length})
      </ClosedToggle>
      {showClosed && (
        <ClosedSection>
          {jobs.map((j) => (
            <RoleCard
              key={j.jobInteractionId}
              onClick={() => onPickJob(j.jobId)}
            >
              <div>
                <RoleTitleLine>{j.title}</RoleTitleLine>
                {j.companyName && <RoleSub>@ {j.companyName}</RoleSub>}
                {j.closeNote && <CloseNoteLine>{j.closeNote}</CloseNoteLine>}
              </div>
              <RolePills>
                <CloseReasonChip>
                  {statusLabel(
                    j.status === "CLOSED"
                      ? (j.closeReason ?? "OTHER")
                      : j.status,
                  )}
                </CloseReasonChip>
              </RolePills>
            </RoleCard>
          ))}
        </ClosedSection>
      )}
    </>
  );
}
