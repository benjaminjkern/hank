"use client";

// In-company picker. Fires after SCANNED jobs have been triaged (the
// shortlist_proposal widget handles SCANNED → SHORTLISTED separately) and
// before the runner would auto-focus the stalest SHORTLISTED job. The user
// picks which job to walk through next from two buckets:
//
//   - Shortlisted (sorted stalest-updatedAt first)
//   - Deferred    (sorted earliest deferredUntil first, nulls last)
//
// Picking a Deferred row revives it server-side (status → SHORTLISTED + defer
// fields cleared) inside the same transaction. The
// "Done with this company" button wraps the company as CAUGHT_UP — same
// effect as the legacy auto-CAUGHT_UP path when no SHORTLISTED jobs remain.
//
// Confirm-first rendering (via useSuggestionPicker — see suggestionPicker.tsx
// + docs/ui.md → "Suggestion picker"): defaults to a single confirm card for
// the top *active* item (first Shortlisted job) with a "See full list" toggle
// that reveals the two buckets + the "Done with this company" button. When
// there are no Shortlisted jobs it opens straight to the list. Picking a row
// in the list returns to the confirm card (select-then-confirm); confirming a
// Deferred job uses the revive wording. Submit markers are unchanged — this is
// a pure presentation layer over the same payload.

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";

import {
  ButtonRow,
  Meta,
  PrimaryButton,
  SecondaryButton,
} from "../../sharedStyles";
import {
  LinkButton,
  SuggestionCard,
  truncateLabel,
  useSuggestionPicker,
} from "../../suggestionPicker";
import {
  buildWidgetSubmissionMessage,
  type NextJobPickerDeferredRow,
  type NextJobPickerPayload,
  type NextJobPickerShortlistedRow,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

// Unified row type for the picker: a SHORTLISTED or DEFERRED job, tagged with
// its bucket so the confirm card can name the revive case and the submit can
// keep the existing visible-label distinction.
type JobItem =
  | { bucket: "shortlisted"; row: NextJobPickerShortlistedRow }
  | { bucket: "deferred"; row: NextJobPickerDeferredRow };

type Props = { payload: NextJobPickerPayload };

// Per-bucket cap before the "Show N more" expander. 5 keeps the first page
// scannable while leaving room for both buckets to show side-by-side without
// dwarfing each other. Users with long backlogs expand once per bucket.
const BUCKET_VISIBLE_CAP = 5;

export function NextJobPickerWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [submitting, setSubmitting] = useState(false);
  const [shortlistedExpanded, setShortlistedExpanded] = useState(false);
  const [deferredExpanded, setDeferredExpanded] = useState(false);

  const disabled = submitting;

  // Default suggestion = top *active* item only (first Shortlisted job). When
  // there's none the picker opens straight to the full list, where deferred
  // rows are still reachable.
  const picker = useSuggestionPicker<JobItem>(
    payload.shortlisted[0]
      ? { bucket: "shortlisted", row: payload.shortlisted[0] }
      : null,
  );

  async function pick(item: JobItem) {
    if (disabled) return;
    setSubmitting(true);
    try {
      await send(
        buildWidgetSubmissionMessage(
          {
            kind: "next_job_picker",
            companyId: payload.companyId,
            choice: "pick",
            jobId: item.row.jobId,
          },
          item.bucket === "deferred"
            ? `[Revive ${item.row.title}]`
            : `[Work on ${item.row.title}]`,
          { jobTitle: item.row.title, bucket: item.bucket },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function markCaughtUp() {
    if (disabled) return;
    setSubmitting(true);
    try {
      await send(
        buildWidgetSubmissionMessage(
          {
            kind: "next_job_picker",
            companyId: payload.companyId,
            choice: "caught_up",
          },
          `[Done with ${payload.companyName}]`,
          { companyName: payload.companyName },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const totalCount = payload.shortlisted.length + payload.deferred.length;
  const minimizedSummary = `${payload.companyName} · ${totalCount} job${totalCount === 1 ? "" : "s"}`;
  const title = `What's next at ${payload.companyName}?`;

  // ---- confirm view: the single top-active suggestion ----
  const selected = picker.selected;
  if (picker.view === "confirm" && selected) {
    const reviving = selected.bucket === "deferred";
    const jobTitle = selected.row.title;
    const primaryLabel = reviving
      ? `Bring ${truncateLabel(jobTitle)} back and walk through`
      : `Walk through ${truncateLabel(jobTitle)}`;
    return (
      <WidgetShell
        title={title}
        minimizable
        disabled={disabled}
        minimizedSummary={minimizedSummary}
        footer={
          <ButtonRow>
            <PrimaryButton onClick={() => pick(selected)} disabled={disabled}>
              {primaryLabel}
            </PrimaryButton>
            <LinkButton onClick={picker.seeAll} disabled={disabled}>
              See full list
            </LinkButton>
          </ButtonRow>
        }
      >
        <SuggestionCard name={jobTitle} subtitle={itemSubtitle(selected)} />
      </WidgetShell>
    );
  }

  // ---- list view: the full Shortlisted / Deferred buckets ----
  const shortlistedVisible = shortlistedExpanded
    ? payload.shortlisted
    : payload.shortlisted.slice(0, BUCKET_VISIBLE_CAP);
  const shortlistedHidden =
    payload.shortlisted.length - shortlistedVisible.length;

  const deferredVisible = deferredExpanded
    ? payload.deferred
    : payload.deferred.slice(0, BUCKET_VISIBLE_CAP);
  const deferredHidden = payload.deferred.length - deferredVisible.length;
  const selectedJobId = selected?.row.jobId ?? null;

  return (
    <WidgetShell
      title={title}
      minimizable
      disabled={disabled}
      minimizedSummary={minimizedSummary}
      footer={
        <ButtonRow>
          {selected && (
            <LinkButton onClick={picker.back} disabled={disabled}>
              ← Back
            </LinkButton>
          )}
          <SecondaryButton onClick={markCaughtUp} disabled={disabled}>
            Done with this company
          </SecondaryButton>
        </ButtonRow>
      }
    >
      {payload.shortlisted.length > 0 && (
        <Section>
          <SectionTitle>Shortlisted</SectionTitle>
          {shortlistedVisible.map((row) => (
            <Row
              key={row.jobId}
              type="button"
              onClick={() => picker.choose({ bucket: "shortlisted", row })}
              disabled={disabled}
              $highlighted={row.jobId === selectedJobId}
            >
              <RowBody>
                <RowName>{row.title}</RowName>
                {(row.location || row.compensation) && (
                  <RowSubtitle>
                    {[row.location, row.compensation]
                      .filter(Boolean)
                      .join(" · ")}
                  </RowSubtitle>
                )}
              </RowBody>
            </Row>
          ))}
          {shortlistedHidden > 0 && (
            <ShowMoreLink
              type="button"
              onClick={() => setShortlistedExpanded(true)}
              disabled={disabled}
            >
              Show {shortlistedHidden} more
            </ShowMoreLink>
          )}
        </Section>
      )}
      {payload.deferred.length > 0 && (
        <Section>
          <SectionTitle>Deferred</SectionTitle>
          {deferredVisible.map((row) => (
            <Row
              key={row.jobId}
              type="button"
              onClick={() => picker.choose({ bucket: "deferred", row })}
              disabled={disabled}
              $highlighted={row.jobId === selectedJobId}
            >
              <RowBody>
                <RowName>{row.title}</RowName>
                <RowSubtitle>{deferredSubtitle(row)}</RowSubtitle>
              </RowBody>
            </Row>
          ))}
          {deferredHidden > 0 && (
            <ShowMoreLink
              type="button"
              onClick={() => setDeferredExpanded(true)}
              disabled={disabled}
            >
              Show {deferredHidden} more
            </ShowMoreLink>
          )}
        </Section>
      )}
      {totalCount === 0 && (
        <Meta>
          Nothing open at {payload.companyName}. Mark caught up to move on.
        </Meta>
      )}
    </WidgetShell>
  );
}

// Subtitle line for the confirm card — location/comp for a shortlisted job,
// the defer reason + revisit date for a deferred one.
function itemSubtitle(item: JobItem): string {
  if (item.bucket === "shortlisted") {
    return [item.row.location, item.row.compensation]
      .filter(Boolean)
      .join(" · ");
  }
  return deferredSubtitle(item.row);
}

function deferredSubtitle(row: NextJobPickerDeferredRow): string {
  if (row.deferReason) return formatDeferReason(row.deferReason);
  return "Deferred";
}

function formatDeferReason(reason: string): string {
  // JobDeferReason enum names → human strings. The payload types this as a bare
  // string (the client doesn't bind to the Prisma enum), so an unrecognized
  // reason falls back to the raw value rather than rendering blank.
  switch (reason) {
    case "OUTRANKED":
      return "Outranked for now";
    case "OTHER":
      return "Deferred";
    default:
      return reason;
  }
}

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const SectionTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: 2px;
`;

const Row = styled.button<{ $highlighted?: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid
    ${({ theme, $highlighted }) =>
      $highlighted ? theme.colors.accent : "transparent"};
  background: transparent;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
  color: ${({ theme }) => theme.colors.text};
  &:not(:disabled):hover {
    background: ${({ theme }) => theme.colors.bgHover};
    border-color: ${({ theme, $highlighted }) =>
      $highlighted ? theme.colors.accent : theme.colors.border};
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const RowBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
`;

const RowName = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const RowSubtitle = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ShowMoreLink = styled.button`
  background: transparent;
  border: none;
  color: ${({ theme }) => theme.colors.accent};
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  text-align: left;
  align-self: flex-start;
  &:not(:disabled):hover {
    text-decoration: underline;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
