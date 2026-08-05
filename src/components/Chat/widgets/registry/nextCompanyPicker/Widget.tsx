"use client";

// Between-pipeline picker. Replaces the silent auto-advance from
// runWhatsNext with user agency: pick a company, pick an open opportunity,
// or jump into add-more-companies. Rendered in the sticky bar above the
// composer; composer stays active so free-text falls through to the
// walkthrough-agent (the default pipeline for cold-start free text).
//
// Confirm-first rendering (via useSuggestionPicker — see suggestionPicker.tsx
// + docs/ui.md → "Suggestion picker"): defaults to a single confirm card for
// the top *active* item (first `immediate` row) with a "See full list" toggle
// that reveals the Immediate / Deferred / Backlog sections + the "Add
// companies" CTA. When `immediate` is empty it opens straight to the list;
// the `empty` payload still shows just the CTA. Picking a row in the list
// returns to the confirm card (select-then-confirm); confirming a DEFERRED
// company revives it. The submission markers below are unchanged — this is a
// pure presentation layer over the same payload.

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import { companyLogoUrl } from "@/lib/companyLogo";
import { initial } from "@/utils/text";

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
  type NextCompanyPickerCompanyRow,
  type NextCompanyPickerJobRow,
  type NextCompanyPickerOpportunityRow,
  type NextCompanyPickerPayload,
  type NextCompanyPickerRow,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

type Props = { payload: NextCompanyPickerPayload };

// Per-section cap before the "Show more" expander. 5 keeps the first page
// tight — most users only act on the top of the list; the long tail expands
// once. Deferred shares the same cap.
const BACKLOG_VISIBLE_CAP = 5;
const DEFERRED_VISIBLE_CAP = 5;

export function NextCompanyPickerWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [submitting, setSubmitting] = useState(false);
  const [deferredExpanded, setDeferredExpanded] = useState(false);
  const [backlogExpanded, setBacklogExpanded] = useState(false);

  // Optional on the payload type for back-compat with rows persisted before
  // the deferred section existed — treat absent as empty.
  const deferred = payload.deferred ?? [];

  const disabled = submitting;

  // Default suggestion = top *active* item only (first Immediate row). When
  // there's no active item the picker opens straight to the full list, where
  // deferred/backlog rows are still reachable. Hook is called unconditionally
  // (before the empty early-return) per the rules of hooks.
  const picker = useSuggestionPicker<NextCompanyPickerRow>(
    payload.immediate[0] ?? null,
  );

  function confirmPick(row: NextCompanyPickerRow) {
    if (row.kind === "company") void pickCompany(row);
    else if (row.kind === "opportunity") void pickOpportunity(row);
    else void pickJob(row);
  }

  async function pickCompany(row: NextCompanyPickerCompanyRow) {
    if (disabled) return;
    setSubmitting(true);
    try {
      await send(
        buildWidgetSubmissionMessage(
          {
            kind: "next_company_picker",
            choice: "company",
            companyId: row.id,
          },
          `[Continue with ${row.name}]`,
          {
            name: row.name,
            logoUrl: companyLogoUrl(row.sourceUrl, row.logoUrl) || null,
          },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function pickOpportunity(row: NextCompanyPickerOpportunityRow) {
    if (disabled) return;
    setSubmitting(true);
    try {
      await send(
        buildWidgetSubmissionMessage(
          {
            kind: "next_company_picker",
            choice: "opportunity",
            opportunityId: row.id,
          },
          `[Continue with ${row.label}]`,
          { label: row.label },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function pickJob(row: NextCompanyPickerJobRow) {
    if (disabled) return;
    setSubmitting(true);
    try {
      await send(
        buildWidgetSubmissionMessage(
          {
            kind: "next_company_picker",
            choice: "job",
            jobId: row.id,
          },
          `[Continue with ${row.title}]`,
          {
            title: row.title,
            companyName: row.companyName,
            logoUrl: companyLogoUrl(row.sourceUrl, row.logoUrl) || null,
          },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function addCompanies() {
    if (disabled) return;
    setSubmitting(true);
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "next_company_picker", choice: "add_companies" },
          "[Add companies to watchlist]",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (payload.empty) {
    return (
      <WidgetShell
        title="Nothing in the queue"
        footer={
          <ButtonRow>
            <PrimaryButton onClick={addCompanies} disabled={disabled}>
              Add companies to watchlist
            </PrimaryButton>
          </ButtonRow>
        }
      >
        <Meta>Your watchlist is empty. Add some companies to get started.</Meta>
      </WidgetShell>
    );
  }

  const totalCount =
    payload.immediate.length + deferred.length + payload.backlog.length;
  const minimizedSummary = `What's next · ${totalCount} item${totalCount === 1 ? "" : "s"}`;

  // ---- confirm view: the single top-active suggestion ----
  const selected = picker.selected;
  if (picker.view === "confirm" && selected) {
    const name = rowDisplayName(selected);
    // Only Immediate (active) rows are auto-suggested, but the user can pick a
    // DEFERRED company from the full list — confirming it revives it, so the
    // button names that explicitly.
    const reviving =
      selected.kind === "company" && selected.status === "DEFERRED";
    const primaryLabel =
      selected.kind === "job"
        ? jobPrimaryLabel(selected)
        : reviving
          ? `Bring ${truncateLabel(name)} back and start`
          : `Start with ${truncateLabel(name)}`;
    return (
      <WidgetShell
        title="What's next?"
        minimizable
        disabled={disabled}
        minimizedSummary={minimizedSummary}
        footer={
          <ButtonRow>
            <PrimaryButton
              onClick={() => confirmPick(selected)}
              disabled={disabled}
            >
              {primaryLabel}
            </PrimaryButton>
            <LinkButton onClick={picker.seeAll} disabled={disabled}>
              See full list
            </LinkButton>
          </ButtonRow>
        }
      >
        <SuggestionCard
          avatar={<Avatar row={selected} />}
          name={name}
          subtitle={selected.subtitle}
        />
      </WidgetShell>
    );
  }

  // ---- list view: the full multi-section list ----
  const deferredVisible = deferredExpanded
    ? deferred
    : deferred.slice(0, DEFERRED_VISIBLE_CAP);
  const deferredHidden = deferred.length - deferredVisible.length;

  const backlogVisible = backlogExpanded
    ? payload.backlog
    : payload.backlog.slice(0, BACKLOG_VISIBLE_CAP);
  const backlogHidden = payload.backlog.length - backlogVisible.length;
  const selectedKey = selected ? rowKey(selected) : null;

  return (
    <WidgetShell
      title="What's next?"
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
          <SecondaryButton onClick={addCompanies} disabled={disabled}>
            Add companies to watchlist
          </SecondaryButton>
        </ButtonRow>
      }
    >
      {payload.immediate.length > 0 && (
        <Section>
          <SectionTitle>Immediate</SectionTitle>
          {payload.immediate.map((row) => (
            <RowButton
              key={rowKey(row)}
              row={row}
              disabled={disabled}
              highlighted={rowKey(row) === selectedKey}
              onChoose={picker.choose}
            />
          ))}
        </Section>
      )}
      {deferred.length > 0 && (
        <Section>
          <SectionTitle>Paused</SectionTitle>
          {deferredVisible.map((row) => (
            <RowButton
              key={rowKey(row)}
              row={row}
              disabled={disabled}
              highlighted={rowKey(row) === selectedKey}
              onChoose={picker.choose}
            />
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
      {payload.backlog.length > 0 && (
        <Section>
          <SectionTitle>Backlog</SectionTitle>
          {backlogVisible.map((row) => (
            <RowButton
              key={rowKey(row)}
              row={row}
              disabled={disabled}
              highlighted={rowKey(row) === selectedKey}
              onChoose={picker.choose}
            />
          ))}
          {backlogHidden > 0 && (
            <ShowMoreLink
              type="button"
              onClick={() => setBacklogExpanded(true)}
              disabled={disabled}
            >
              Show {backlogHidden} more
            </ShowMoreLink>
          )}
        </Section>
      )}
    </WidgetShell>
  );
}

function rowKey(row: NextCompanyPickerRow): string {
  return `${row.kind}:${row.id}`;
}

function rowDisplayName(row: NextCompanyPickerRow): string {
  if (row.kind === "company") return row.name;
  if (row.kind === "opportunity") return row.label;
  return row.title;
}

// Confirm-button label for a picked job row — phrased by what the user is about
// to do, derived from the job's status.
function jobPrimaryLabel(row: NextCompanyPickerJobRow): string {
  const title = truncateLabel(row.title);
  if (row.status === "INTERVIEW_DEBRIEF") return `Debrief ${title}`;
  if (row.status === "OFFERED") return `Review ${title} offer`;
  return `Pick ${title} back up`;
}

type RowButtonProps = {
  row: NextCompanyPickerRow;
  disabled: boolean;
  // Outlines the row matching the current confirm-card selection so the user
  // can see which one "Back" will return to.
  highlighted: boolean;
  // Clicking a list row selects it and returns to the confirm card (not an
  // immediate submit) — the second tap on the confirm button commits.
  onChoose: (row: NextCompanyPickerRow) => void;
};

function RowButton({ row, disabled, highlighted, onChoose }: RowButtonProps) {
  return (
    <Row
      type="button"
      onClick={() => onChoose(row)}
      disabled={disabled}
      $highlighted={highlighted}
    >
      <Avatar row={row} />
      <RowBody>
        <RowName>{rowDisplayName(row)}</RowName>
        <RowSubtitle>{row.subtitle}</RowSubtitle>
      </RowBody>
    </Row>
  );
}

function Avatar({ row }: { row: NextCompanyPickerRow }) {
  const [failed, setFailed] = useState(false);
  if (row.kind === "opportunity") {
    return (
      <AvatarBox>
        <AvatarMonogram>{initial(row.label)}</AvatarMonogram>
      </AvatarBox>
    );
  }
  // company OR job — both carry the parent company's logo/source for the chip,
  // falling back to a monogram of the company name (job rows) / company (company
  // rows), then the title if a job has no company name on file.
  const url = companyLogoUrl(row.sourceUrl, row.logoUrl);
  const monogramSeed =
    row.kind === "company" ? row.name : (row.companyName ?? row.title);
  return (
    <AvatarBox>
      {failed || url === "" ? (
        <AvatarMonogram>{initial(monogramSeed)}</AvatarMonogram>
      ) : (
        <AvatarImg src={url} alt="" onError={() => setFailed(true)} />
      )}
    </AvatarBox>
  );
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

const AvatarBox = styled.div`
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: ${({ theme }) => theme.colors.bgMuted};
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex-shrink: 0;
`;

const AvatarImg = styled.img`
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

const AvatarMonogram = styled.div`
  font-size: 13px;
  font-weight: 700;
  color: ${({ theme }) => theme.colors.text};
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
