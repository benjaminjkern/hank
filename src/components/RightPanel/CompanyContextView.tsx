"use client";

import { useState } from "react";
import styled from "styled-components";

import {
  useChatStore,
  type FocusedCompanyView,
  type CompanyJobView,
} from "@/lib/chatStore";
import {
  statusTone,
  statusColor,
  statusLabel,
  companyEventLabel,
  jobStatusColor,
  closedActionLabel,
  appliedTierBadge,
} from "@/lib/statusColors";
import { relativeTime } from "@/utils/date";
import { nowMs } from "@/utils/now";
import { initial } from "@/utils/text";

import { ContactCard } from "./shared/ContactCard";
import {
  RecentActivityList,
  type RecentActivityItem,
} from "./shared/RecentActivity";
import { useExpandable } from "./shared/useExpandable";

const Card = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  overflow: hidden;
  margin-bottom: ${({ theme }) => theme.space.md};
`;

const HeaderRow = styled.div`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.lg};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`;

const LogoBox = styled.div`
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
`;

const LogoImg = styled.img`
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

const Monogram = styled.div`
  font-size: 22px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.accent};
`;

const HeaderMain = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const CompanyName = styled.h2`
  font-size: 18px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

const HeaderMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const CareersLink = styled.a`
  color: ${({ theme }) => theme.colors.accent};
  word-break: break-all;
  &:hover {
    color: ${({ theme }) => theme.colors.accentHover};
  }
`;

const BoardLink = styled.button`
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.accentHover};
  }
`;

const Dot = styled.span`
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const StatusPill = styled.span<{ $status: string }>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status }) => statusColor(theme, $status)};
`;

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

// Tone-aware reason chip for the BLOCKED / DEFERRED banners — amber, not the
// red CloseReasonLabel uses for CLOSED. Color tracks the status tone so a
// "couldn't read the board" set-aside doesn't read as a hard rejection.
const ReasonChip = styled.span<{ $status: string }>`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: ${({ theme, $status }) => statusColor(theme, $status)};
`;

const CloseNoteText = styled.span`
  color: ${({ theme }) => theme.colors.text};
`;

// One-line company description (the basic-info hunter's shortDescription). Sits
// under the header so the user sees what the company actually does. Padded on
// all four sides — it butts up against HeaderRow's bottom rule otherwise, with
// only the line-height's half-leading between the rule and the glyphs.
// CloseBanner renders in this same slot, so keep the two vertically symmetric.
const Description = styled.p`
  margin: 0;
  padding: ${({ theme }) =>
    `${theme.space.md} ${theme.space.xl} ${theme.space.md}`};
  font-size: 13px;
  line-height: 1.45;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Stats = styled.div`
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.xl}`};
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: ${({ theme }) => theme.space.md};
`;

const Stat = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const StatValue = styled.div<{ $tone?: "accent" | "muted" | "subtle" }>`
  font-size: 20px;
  font-weight: 600;
  color: ${({ theme, $tone }) =>
    $tone === "accent"
      ? theme.colors.accent
      : $tone === "subtle"
        ? theme.colors.textSubtle
        : theme.colors.text};
`;

const StatLabel = styled.div`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const SectionHead = styled.div`
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
`;

const SectionTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const SectionCount = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
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

const JobTitle = styled.div`
  color: ${({ theme }) => theme.colors.text};
`;

// `$appliedAt` + `$now` only flow in for APPLIED job rows; without them
// jobStatusColor falls back to the plain status tone.
const JobStatusPill = styled.span<{
  $status: string;
  $appliedAt?: string | null;
  $now?: number;
}>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 7px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status, $appliedAt, $now }) =>
    jobStatusColor(theme, $status, $appliedAt, $now)};
  white-space: nowrap;
`;

// Small "Applied 3 weeks ago" / "Rejected 3 weeks ago" timing caption under a
// role's title — pairs the date with the status so the user sees when a role
// went out or ended without opening it.
const RowCaption = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 2px;
`;

const Empty = styled.div`
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
`;

const ShowMoreButton = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  background: transparent;
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  text-align: center;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Never-pursued jobs use the same toggle styling as the dashboard's "skipped
// companies" section — dashed border, muted, hidden by default. No top
// margin: the preceding section's Card mb keeps spacing consistent with every
// other section, no double gap.
const ClosedToggle = styled.button`
  margin-bottom: ${({ theme }) => theme.space.md};
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  border: 1px dashed ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  cursor: pointer;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

// No wrapper opacity — dimming the whole section made rows read as
// non-interactive. Muted text colors on the row itself already signal
// "closed" without sapping the click affordance.
const ClosedSection = styled.div`
  margin-top: ${({ theme }) => theme.space.sm};
  margin-bottom: ${({ theme }) => theme.space.md};
`;

const ClosedJobRow = styled.button.attrs({ type: "button" })`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  align-items: center;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: ${({ theme }) => theme.space.xs};
  text-align: left;
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
    color: ${({ theme }) => theme.colors.text};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

// Sub-status label for the skipped-jobs section. Matches the dashboard's
// skipped-companies treatment: muted monospace, uppercase. For CLOSED rows
// we show the closeReason (NOT_A_MATCH / OUTRANKED / etc.); for REJECTED
// we just show "REJECTED" since the status itself is the reason.
const CloseReasonChip = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
`;

// Freeform skip note rendered under the title when present. Muted, smaller,
// soft-wrapped — replaces the previous hover-only tooltip so the context is
// visible without the user discovering the tooltip.
const CloseNoteLine = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 2px;
  line-height: 1.4;
`;

// Padded body for the "Recent activity" card. The card uses the same
// SectionHead chrome as its siblings (Jobs / Notes); the list itself needs
// its own padding since the SectionHead-style Card supplies none.
const RecentActivityBody = styled.div`
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
`;

const ContactsBody = styled.div`
  padding: ${({ theme }) => `0 ${theme.space.lg} ${theme.space.md}`};
`;

const NoteBody = styled.pre`
  margin: 0;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.text};
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
`;

// Company page job groups, split by whether the user actually pursued the role:
// - pipeline      = still open AND live work: NEW + SCANNED + SHORTLISTED +
//                   APPLIED + interview stages + OFFERED. Sorted so roles the
//                   user owes a move on float above freshly-scanned ones.
// - deferred      = "could apply, outranked for now". Open, but deliberately
//                   parked — nothing is owed on it, so counting it as pipeline
//                   overstates how much is actually in flight.
// - pursuedClosed = roles the user actually engaged with that are now closed:
//                   REJECTED (company passed after you applied) and
//                   CLOSED/WITHDRAWN (applied, then pulled the application).
//                   Kept visible — this is real application history.
// - neverPursued  = roles that ended before you applied: CLOSED for any
//                   pre-apply reason (NOT_A_MATCH / USER_REJECTED / …) AND
//                   DELISTED (a posting only flips to DELISTED from a non-applied
//                   state — NEW/SCANNED/SHORTLISTED/DEFERRED — so it was never
//                   applied to: a lost cause). Noise; hidden behind a toggle.
type CompanyJobGroups = {
  pipeline: CompanyJobView[];
  deferred: CompanyJobView[];
  pursuedClosed: CompanyJobView[];
  neverPursued: CompanyJobView[];
};

// Within the pipeline, float the roles the user owes a move on (focusNow:
// SCANNED/SHORTLISTED/OFFERED/…) above applied/in-flight (resting), then
// freshly-surfaced NEW — so a scan dropping 20 new roles doesn't bury an offer
// awaiting a decision under the preview cap.
const PIPELINE_TONE_RANK: Record<string, number> = {
  focusNow: 0,
  resting: 1,
  notStarted: 2,
};

function groupJobs(jobs: CompanyJobView[]): CompanyJobGroups {
  const pipeline: CompanyJobView[] = [];
  const deferred: CompanyJobView[] = [];
  const pursuedClosed: CompanyJobView[] = [];
  const neverPursued: CompanyJobView[] = [];
  for (const j of jobs) {
    if (j.status === "REJECTED") {
      pursuedClosed.push(j);
    } else if (j.status === "DELISTED") {
      // The posting came down while the role was still non-applied (only
      // NEW/SCANNED/SHORTLISTED/DEFERRED rows flip to DELISTED) — never pursued.
      neverPursued.push(j);
    } else if (j.status === "CLOSED") {
      // WITHDRAWN = applied then pulled the application (pursued); every other
      // close reason is a pre-apply pass.
      if (j.closeReason === "WITHDRAWN") pursuedClosed.push(j);
      else neverPursued.push(j);
    } else if (j.status === "DEFERRED") {
      deferred.push(j);
    } else {
      pipeline.push(j);
    }
  }
  const byRecency = (a: CompanyJobView, b: CompanyJobView) =>
    b.updatedAt.localeCompare(a.updatedAt);
  pipeline.sort((a, b) => {
    const ra = PIPELINE_TONE_RANK[statusTone(a.status)] ?? 2;
    const rb = PIPELINE_TONE_RANK[statusTone(b.status)] ?? 2;
    return ra - rb || byRecency(a, b);
  });
  deferred.sort(byRecency);
  pursuedClosed.sort(byRecency);
  neverPursued.sort(byRecency);
  return { pipeline, deferred, pursuedClosed, neverPursued };
}

const PREVIEW_COUNT = 5;
// Pipeline is the main content and folds in NEW/SCANNED, so it gets a roomier
// preview than the terminal sections before "show more" kicks in.
const PIPELINE_PREVIEW_COUNT = 8;

export function CompanyContextView({
  company,
}: {
  company: NonNullable<FocusedCompanyView>;
}) {
  const viewJob = useChatStore((s) => s.viewJob);
  const viewShortlistBoard = useChatStore((s) => s.viewShortlistBoard);
  const buckets = groupJobs(company.jobs);
  const {
    visible: visibleContacts,
    truncated: contactsTruncated,
    canCollapse: canCollapseContacts,
    hiddenCount: hiddenContactCount,
    expand: expandContacts,
    collapse: collapseContacts,
  } = useExpandable(company.contacts, PREVIEW_COUNT);

  return (
    <>
      <Card>
        <HeaderRow>
          <CompanyLogo logoUrl={company.logoUrl} name={company.name} />
          <HeaderMain>
            <CompanyName>{company.name}</CompanyName>
            <HeaderMeta>
              {company.sourceUrl ? (
                <CareersLink
                  href={company.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {company.sourceUrl}
                </CareersLink>
              ) : (
                <span>(no careers URL yet)</span>
              )}
              {company.lastActivityAt && (
                <>
                  <Dot>·</Dot>
                  <span>
                    Last activity {relativeTime(company.lastActivityAt)}
                  </span>
                </>
              )}
              {company.lastScrapedJobsAt && (
                <>
                  <Dot>·</Dot>
                  <span>Scraped {relativeTime(company.lastScrapedJobsAt)}</span>
                </>
              )}
              {company.shortlistBoardOpen && (
                <>
                  <Dot>·</Dot>
                  <BoardLink
                    onClick={() => void viewShortlistBoard(company.id)}
                  >
                    Shortlist to review
                  </BoardLink>
                </>
              )}
            </HeaderMeta>
          </HeaderMain>
          <StatusPill $status={company.status}>
            {statusLabel(company.status)}
          </StatusPill>
        </HeaderRow>
        {company.description && (
          <Description>{company.description}</Description>
        )}
        {company.status === "CLOSED" && (
          <CloseBanner>
            <CloseReasonLabel>
              {statusLabel(company.closeReason ?? "OTHER")}
            </CloseReasonLabel>
            {company.closeNote && (
              <CloseNoteText>{company.closeNote}</CloseNoteText>
            )}
          </CloseBanner>
        )}
        {company.status === "BLOCKED" && (
          <CloseBanner>
            <ReasonChip $status="BLOCKED">
              {statusLabel(company.blockReason ?? "OTHER")}
            </ReasonChip>
            {company.blockNote && (
              <CloseNoteText>{company.blockNote}</CloseNoteText>
            )}
          </CloseBanner>
        )}
        {company.status === "PAUSED" && (
          <CloseBanner>
            <ReasonChip $status="PAUSED">
              {statusLabel(company.pauseReason ?? "OTHER")}
            </ReasonChip>
            {company.pauseNote && (
              <CloseNoteText>{company.pauseNote}</CloseNoteText>
            )}
          </CloseBanner>
        )}
        <Stats>
          <Stat>
            <StatValue $tone="accent">{buckets.pipeline.length}</StatValue>
            <StatLabel>In pipeline</StatLabel>
          </Stat>
          <Stat>
            <StatValue $tone="muted">{buckets.deferred.length}</StatValue>
            <StatLabel>Deferred</StatLabel>
          </Stat>
          <Stat>
            <StatValue>{buckets.pursuedClosed.length}</StatValue>
            <StatLabel>Pursued</StatLabel>
          </Stat>
          <Stat>
            <StatValue $tone="subtle">{buckets.neverPursued.length}</StatValue>
            <StatLabel>Never pursued</StatLabel>
          </Stat>
        </Stats>
      </Card>

      <JobGroup
        title="In pipeline"
        jobs={buckets.pipeline}
        emptyText="No open roles right now."
        previewCount={PIPELINE_PREVIEW_COUNT}
        onPick={(j) => void viewJob(j.jobId)}
      />
      {buckets.deferred.length > 0 && (
        <JobGroup
          title="Deferred"
          jobs={buckets.deferred}
          emptyText=""
          previewCount={PREVIEW_COUNT}
          onPick={(j) => void viewJob(j.jobId)}
        />
      )}
      {buckets.pursuedClosed.length > 0 && (
        <JobGroup
          title="Pursued and closed"
          jobs={buckets.pursuedClosed}
          emptyText=""
          previewCount={PREVIEW_COUNT}
          onPick={(j) => void viewJob(j.jobId)}
        />
      )}

      <ClosedJobsSection
        jobs={buckets.neverPursued}
        onPick={(j) => void viewJob(j.jobId)}
      />

      {company.contacts.length > 0 && (
        <Card>
          <SectionHead>
            <SectionTitle>Contacts</SectionTitle>
            <SectionCount>{company.contacts.length}</SectionCount>
          </SectionHead>
          <ContactsBody>
            {visibleContacts.map((c) => (
              <ContactCard key={c.id} contact={c} />
            ))}
            {contactsTruncated && (
              <ShowMoreButton onClick={expandContacts}>
                Show {hiddenContactCount} more
              </ShowMoreButton>
            )}
            {!contactsTruncated && canCollapseContacts && (
              <ShowMoreButton onClick={collapseContacts}>
                Collapse
              </ShowMoreButton>
            )}
          </ContactsBody>
        </Card>
      )}

      {company.recentEvents.length > 0 && (
        <Card>
          <SectionHead>
            <SectionTitle>Recent activity</SectionTitle>
            <SectionCount>{company.recentEventsTotal}</SectionCount>
          </SectionHead>
          <RecentActivityBody>
            <RecentActivityList
              items={company.recentEvents.map((e): RecentActivityItem => ({
                id: e.id,
                type: companyEventLabel(e.type),
                occurredAt: e.occurredAt,
                notes: e.notes,
                context: e.jobTitle,
              }))}
              total={company.recentEventsTotal}
            />
          </RecentActivityBody>
        </Card>
      )}

      {company.memoryNote && (
        <Card>
          <SectionHead>
            <SectionTitle>Notes</SectionTitle>
            <SectionCount>from memory</SectionCount>
          </SectionHead>
          <NoteBody>{company.memoryNote}</NoteBody>
        </Card>
      )}
    </>
  );
}

function CompanyLogo({ logoUrl, name }: { logoUrl: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <LogoBox>
      {failed ? (
        <Monogram>{initial(name)}</Monogram>
      ) : (
        <LogoImg src={logoUrl} alt="" onError={() => setFailed(true)} />
      )}
    </LogoBox>
  );
}

function JobGroup({
  title,
  jobs,
  emptyText,
  previewCount,
  onPick,
}: {
  title: string;
  jobs: CompanyJobView[];
  emptyText: string;
  previewCount?: number;
  onPick: (job: CompanyJobView) => void;
}) {
  const { visible, truncated, canCollapse, hiddenCount, expand, collapse } =
    useExpandable(jobs, previewCount ?? jobs.length);
  const now = nowMs();

  return (
    <Card>
      <SectionHead>
        <SectionTitle>{title}</SectionTitle>
        <SectionCount>{jobs.length}</SectionCount>
      </SectionHead>
      {jobs.length === 0 ? (
        <Empty>{emptyText}</Empty>
      ) : (
        <>
          {visible.map((j) => {
            // One caption per row, saying why it's sitting where it is: when it
            // was applied (still open), why it's parked (deferred), or when it
            // ended (terminal). Statuses are mutually exclusive, so at most one
            // fires.
            const caption =
              j.status === "APPLIED" && j.appliedAt
                ? `Applied ${relativeTime(j.appliedAt)}`
                : j.status === "DEFERRED"
                  ? (j.deferNote ?? statusLabel(j.deferReason ?? "OTHER"))
                  : j.closedAt
                    ? `${closedActionLabel(j.status, j.closeReason)} ${relativeTime(j.closedAt)}`
                    : null;
            return (
              <Row key={j.jobInteractionId} onClick={() => onPick(j)}>
                <div>
                  <JobTitle>{j.title}</JobTitle>
                  {caption && <RowCaption>{caption}</RowCaption>}
                </div>
                <JobStatusPill
                  $status={j.status}
                  $appliedAt={j.appliedAt}
                  $now={now}
                >
                  {statusLabel(j.status)}
                  {appliedTierBadge(j.appliedAt, now)}
                </JobStatusPill>
              </Row>
            );
          })}
          {truncated && (
            <ShowMoreButton onClick={expand}>
              Show {hiddenCount} more
            </ShowMoreButton>
          )}
          {!truncated && canCollapse && (
            <ShowMoreButton onClick={collapse}>Collapse</ShowMoreButton>
          )}
        </>
      )}
    </Card>
  );
}

function ClosedJobsSection({
  jobs,
  onPick,
}: {
  jobs: CompanyJobView[];
  onPick: (job: CompanyJobView) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  if (jobs.length === 0) return null;
  return (
    <>
      <ClosedToggle onClick={() => setShowClosed((s) => !s)}>
        {showClosed ? "Hide" : "Show"} never pursued ({jobs.length})
      </ClosedToggle>
      {showClosed && (
        <ClosedSection>
          {jobs.map((j) => (
            <ClosedJobRow key={j.jobInteractionId} onClick={() => onPick(j)}>
              <div>
                <JobTitle>{j.title}</JobTitle>
                {j.closedAt && (
                  <CloseNoteLine>
                    {closedActionLabel(j.status, j.closeReason)}{" "}
                    {relativeTime(j.closedAt)}
                  </CloseNoteLine>
                )}
                {j.closeNote && <CloseNoteLine>{j.closeNote}</CloseNoteLine>}
              </div>
              <CloseReasonChip>
                {statusLabel(
                  j.status === "CLOSED" ? (j.closeReason ?? "OTHER") : j.status,
                )}
              </CloseReasonChip>
            </ClosedJobRow>
          ))}
        </ClosedSection>
      )}
    </>
  );
}
