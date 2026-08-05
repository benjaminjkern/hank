"use client";

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import { formatJobRefToken } from "@/lib/jobRefToken";
import {
  jobStatusColor,
  closedActionLabel,
  appliedTierBadge,
} from "@/lib/statusColors";
import type {
  ApplicationQuestion,
  ApplicationQuestionsEnvelope,
  FocusedJobView,
} from "@/server/agent/tools/lib/types";
import { relativeTime } from "@/utils/date";
import { nowMs } from "@/utils/now";
import { initial } from "@/utils/text";

import {
  Section,
  SectionHeader,
  SectionLabel,
} from "./shared/applicationArtifacts";
import {
  RecentActivity,
  type RecentActivityItem,
} from "./shared/RecentActivity";
import { useExpandable } from "./shared/useExpandable";
// Cover-letter / short-answer editor + reuse switch + the three section chrome
// primitives now live in the shared module (reused by DocumentsView).

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

// Stacks the title, optional lead back-link, and company line. Uses the same
// vertical gap as the parent Header's gap so the spacing between title and
// company line matches the spacing between company line and the meta row
// (location · comp · employment type) below.
const HeaderMain = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  gap: ${({ theme }) => theme.space.sm};
`;

const Title = styled.h2`
  font-size: 16px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

// Back-link chip that surfaces above the company line when the JobInteraction
// is attached to an inbound Opportunity. Visually similar to a breadcrumb
// crumb (mono font, subtle color) so it reads as navigation rather than a
// pill. Clicking jumps to the parent lead — answers "how did this enter my
// pipeline?" without requiring the user to navigate back to the dashboard.
const LeadLink = styled.button`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  background: transparent;
  padding: 2px 4px;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  text-align: left;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const CompanyLine = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
`;

// Clickable variant of CompanyLine. Renders when the job is linked to a real
// Company (job.company != null) so the user can drill into the company page
// from the job header. Negative left margin offsets the padding so the
// content sits flush with the title above.
const CompanyLineButton = styled.button.attrs({ type: "button" })`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  background: transparent;
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  text-align: left;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Small logo chip next to the company name. 18px tall, square, falls back
// to a monogram via the same initial() helper the company page uses.
const CompanyLogoBox = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  overflow: hidden;
`;

const CompanyLogoImg = styled.img`
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

const CompanyLogoMonogram = styled.span`
  font-size: 10px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.accent};
`;

// Bullet-separated metadata line under the company name: location ·
// compensation · employment type · department. Only renders fields the
// scraper actually pulled (all four are nullable). The separator dots
// match the company-page header treatment.
const MetaLine = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.sm};
  align-items: baseline;
`;

const MetaDot = styled.span`
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// Skip banner under the header — mirrors CompanyContextView's CloseBanner
// pattern. Only renders when the JobInteraction is CLOSED. Shows the
// reason (NOT_A_MATCH / OUTRANKED / etc.) and the freeform closeNote.
const CloseBanner = styled.div`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.xl}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.sm};
  align-items: baseline;
`;

const CloseReasonLabel = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: ${({ theme }) => theme.colors.danger};
`;

const CloseNoteText = styled.span`
  color: ${({ theme }) => theme.colors.text};
`;

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

// Small caption under the status pill that says "via recruiter" / "via
// referral" when applyChannel is set to RECRUITER or REFERRAL. DIRECT is
// the implicit default — no caption needed (it'd just be visual noise on
// every applied row).
const ChannelCaption = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-top: 2px;
`;

const StatusBlock = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
`;

const Actions = styled.div`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`;

const PrimaryButton = styled.button<{ $disabled?: boolean }>`
  flex: 1;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  background: ${({ theme, $disabled }) =>
    $disabled ? theme.colors.bgMuted : theme.colors.accent};
  color: ${({ theme, $disabled }) => ($disabled ? theme.colors.textSubtle : theme.colors.onAccent)};
  border-radius: ${({ theme }) => theme.radius.md};
  font-size: 13px;
  font-weight: 500;
  cursor: ${({ $disabled }) => ($disabled ? "not-allowed" : "pointer")};

  &:hover {
    background: ${({ theme, $disabled }) =>
      $disabled ? theme.colors.bgMuted : theme.colors.accentHover};
  }
`;

const SecondaryButton = styled.a`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  font-size: 13px;
  text-decoration: none;
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const TextButton = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  padding: 0;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.accentHover};
  }
`;

const QuestionRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  font-size: 12px;
  padding: 4px 0;
  color: ${({ theme }) => theme.colors.text};
`;

const QuestionMetaChip = styled.span<{ $tone?: "required" | "type" | "user" }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 1px 6px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $tone }) =>
    $tone === "required"
      ? theme.colors.danger
      : $tone === "user"
        ? theme.colors.accent
        : theme.colors.textSubtle};
`;

const Placeholder = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
`;

const ClampedDescription = styled.div<{ $expanded: boolean }>`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.55;
  white-space: pre-wrap;
  ${({ $expanded }) =>
    $expanded
      ? `
    max-height: 480px;
    overflow-y: auto;
  `
      : `
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `}
`;

// Statuses for which the "I submitted" button is locked. CLOSED isn't here on
// purpose — if the user changes their mind after a skip they can still mark it
// applied.
const TERMINAL = new Set([
  "APPLIED",
  "RESPONDED",
  "INTERVIEW_SCHEDULED",
  "INTERVIEW_DEBRIEF",
  "OFFERED",
  "REJECTED",
]);

export function JobDetailView({ job }: { job: NonNullable<FocusedJobView> }) {
  const send = useChatStore((s) => s.send);
  const streaming = useChatStore((s) => s.streaming);
  const viewOpportunity = useChatStore((s) => s.viewOpportunity);
  const viewCompany = useChatStore((s) => s.viewCompany);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const submitted = TERMINAL.has(job.jobInteraction.status);

  const companyLabel =
    job.company?.name ?? job.companyNameFallback ?? "(no company yet)";
  const lead = job.jobInteraction.opportunity;

  function markSubmitted() {
    if (streaming || submitted) return;
    const ref = formatJobRefToken(job.id, `${job.title} @ ${companyLabel}`);
    void send(`I submitted ✓ ${ref}`);
  }

  const metaParts = [
    job.location,
    job.compensation,
    job.employmentType,
    job.department,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));

  return (
    <Card>
      <Header>
        <TopRow>
          <HeaderMain>
            <Title>{job.title}</Title>
            {lead && (
              <LeadLink onClick={() => void viewOpportunity(lead.id)}>
                ← Pitched via {lead.label}
              </LeadLink>
            )}
            {job.company ? (
              <CompanyLineButton
                onClick={() => void viewCompany(job.company!.id)}
                aria-label={`View ${job.company.name}`}
              >
                <CompanyLogoChip
                  logoUrl={job.company.logoUrl}
                  name={job.company.name}
                />
                {companyLabel}
              </CompanyLineButton>
            ) : (
              <CompanyLine>{companyLabel}</CompanyLine>
            )}
          </HeaderMain>
          <StatusBlock>
            <StatusPill
              $status={job.jobInteraction.status}
              $appliedAt={job.jobInteraction.appliedAt}
              $now={nowMs()}
            >
              {job.jobInteraction.status}
              {appliedTierBadge(job.jobInteraction.appliedAt, nowMs())}
            </StatusPill>
            {job.jobInteraction.status === "APPLIED" &&
              job.jobInteraction.appliedAt && (
                <ChannelCaption>
                  applied {relativeTime(job.jobInteraction.appliedAt)}
                </ChannelCaption>
              )}
            {job.jobInteraction.closedAt && (
              <ChannelCaption>
                {closedActionLabel(
                  job.jobInteraction.status,
                  job.jobInteraction.closeReason,
                ).toLowerCase()}{" "}
                {relativeTime(job.jobInteraction.closedAt)}
              </ChannelCaption>
            )}
            {job.jobInteraction.applyChannel === "RECRUITER" && (
              <ChannelCaption>via recruiter</ChannelCaption>
            )}
            {job.jobInteraction.applyChannel === "REFERRAL" && (
              <ChannelCaption>via referral</ChannelCaption>
            )}
          </StatusBlock>
        </TopRow>
        {metaParts.length > 0 && (
          <MetaLine>
            {metaParts.map((p, i) => (
              <span key={i}>
                {i > 0 && <MetaDot>· </MetaDot>}
                {p}
              </span>
            ))}
          </MetaLine>
        )}
      </Header>
      {job.jobInteraction.status === "CLOSED" && (
        <CloseBanner>
          <CloseReasonLabel>
            {job.jobInteraction.closeReason ?? "OTHER"}
          </CloseReasonLabel>
          {job.jobInteraction.closeNote && (
            <CloseNoteText>{job.jobInteraction.closeNote}</CloseNoteText>
          )}
        </CloseBanner>
      )}

      <Actions>
        {job.sourceUrl ? (
          <SecondaryButton
            href={job.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open posting →
          </SecondaryButton>
        ) : null}
        <PrimaryButton
          onClick={markSubmitted}
          $disabled={streaming || submitted || readOnly}
        >
          {submitted ? "Submitted ✓" : "I submitted"}
        </PrimaryButton>
      </Actions>

      {job.description && job.description.trim().length > 0 && (
        <DescriptionSection key={`desc-${job.id}`} text={job.description} />
      )}

      <ApplicationQuestionsPanel
        key={`appq-${job.id}`}
        envelope={job.applicationQuestions}
      />

      {/* Per-job editing state — key={job.id} resets local state on focus
          change so a half-typed entry doesn't leak to the next job. */}
      <ApplicationBody key={`body-${job.id}`} job={job} />

      <Section>
        <RecentActivity
          items={job.jobInteraction.events.map((e): RecentActivityItem => ({
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

function CompanyLogoChip({ logoUrl, name }: { logoUrl: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <CompanyLogoBox>
      {failed ? (
        <CompanyLogoMonogram>{initial(name)}</CompanyLogoMonogram>
      ) : (
        <CompanyLogoImg src={logoUrl} alt="" onError={() => setFailed(true)} />
      )}
    </CompanyLogoBox>
  );
}

function DescriptionSection({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Section>
      <SectionHeader>
        <SectionLabel>Description</SectionLabel>
        <TextButton onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </TextButton>
      </SectionHeader>
      <ClampedDescription $expanded={expanded}>{text}</ClampedDescription>
    </Section>
  );
}

// The application's presence on the job page: what state it's in and a way in.
// The writing itself lives on the application page, which has room for it.
function ApplicationBody({ job }: { job: NonNullable<FocusedJobView> }) {
  const viewApplication = useChatStore((s) => s.viewApplication);

  const hasCoverLetter =
    (job.jobInteraction.coverLetter ?? "").trim().length > 0;
  const answerCount = (job.jobInteraction.shortAnswers ?? []).filter((a) =>
    a.answer.trim(),
  ).length;
  const written = (hasCoverLetter ? 1 : 0) + answerCount;
  const asks =
    job.applicationQuestions?.status === "ok"
      ? job.applicationQuestions.questions.length +
        (job.applicationQuestions.coverLetter ? 1 : 0)
      : null;

  const summary =
    written > 0
      ? `${written} of ${asks ?? written} written`
      : asks === null
        ? "Not read yet"
        : asks === 0
          ? "Nothing to write — standard fields only"
          : `${asks} to write`;

  return (
    <Section>
      <SectionHeader>
        <SectionLabel>Application</SectionLabel>
        <TextButton onClick={() => void viewApplication(job.id)}>
          Open application →
        </TextButton>
      </SectionHeader>
      <ApplicationSummary>{summary}</ApplicationSummary>
    </Section>
  );
}

const ApplicationSummary = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

// Number of questions visible when the section is collapsed. Mirrors the
// "2 lines" preview the description section uses — a short hint of what's
// inside without dominating the page on long forms.
const QUESTIONS_PREVIEW = 2;

function ApplicationQuestionsPanel({
  envelope,
}: {
  envelope: ApplicationQuestionsEnvelope | null;
}) {
  // Collapsed by default — mirrors DescriptionSection's preview-then-expand
  // pattern. Toggle is only rendered when there's more than the preview to
  // show.
  const questions = envelope?.status === "ok" ? envelope.questions : [];
  const { visible, expanded, canCollapse, toggle } = useExpandable(
    questions,
    QUESTIONS_PREVIEW,
  );
  if (!envelope) return null;
  // "empty" means the form has no custom questions (just the standard ATS
  // fields like name/email/resume). Showing an empty section just adds noise
  // — hide it. Other states (ok / unsupported / error) carry information
  // worth surfacing.
  if (envelope.status === "empty") return null;

  if (envelope.status === "ok") {
    const total = envelope.questions.length;
    return (
      <Section>
        <SectionHeader>
          <SectionLabel>Application form · {total}</SectionLabel>
          {canCollapse && (
            <TextButton onClick={toggle}>
              {expanded ? "Show less" : "Show more"}
            </TextButton>
          )}
        </SectionHeader>
        <div>
          {visible.map((q, i) => (
            <ApplicationQuestionRow key={i} q={q} />
          ))}
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <SectionHeader>
        <SectionLabel>Application form</SectionLabel>
      </SectionHeader>
      {envelope.status === "unsupported" && (
        <Placeholder>
          Questions aren&apos;t scraped for this ATS — ask Hank or check the
          apply page.
        </Placeholder>
      )}
      {envelope.status === "error" && (
        <Placeholder>Question fetch failed: {envelope.error}</Placeholder>
      )}
    </Section>
  );
}

function ApplicationQuestionRow({ q }: { q: ApplicationQuestion }) {
  return (
    <QuestionRow>
      <span>“{q.question}”</span>
      {q.required && (
        <QuestionMetaChip $tone="required">required</QuestionMetaChip>
      )}
      {q.type && <QuestionMetaChip $tone="type">{q.type}</QuestionMetaChip>}
      {q.source === "user" && (
        <QuestionMetaChip $tone="user">added manually</QuestionMetaChip>
      )}
    </QuestionRow>
  );
}
