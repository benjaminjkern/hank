"use client";

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import type {
  FocusedJobView,
  ShortAnswer,
} from "@/server/agent/tools/lib/types";

// The right panel's shared section chrome, plus the controls that act on a
// drafted artifact WITHOUT editing its text: the "reuse when drafting" switch,
// the remove button, and the JobInteraction patch they share.
//
// Writing the text itself lives on the application page
// ([../ApplicationView.tsx](../ApplicationView.tsx)) and nowhere else — see
// docs/flows.md. What's here is what the Documents list and the job
// page still need in order to show and manage an artifact they don't edit.

export const Section = styled.section`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  &:last-child {
    border-bottom: none;
  }
`;

export const SectionHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: ${({ theme }) => theme.space.sm};
  gap: ${({ theme }) => theme.space.sm};
`;

export const SectionLabel = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
`;

const InlineButton = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
  &:disabled {
    color: ${({ theme }) => theme.colors.textSubtle};
    cursor: not-allowed;
  }
`;

const DangerInlineButton = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.danger};
    background: ${({ theme }) => theme.colors.bgMuted};
  }
`;

// Reuse toggle. The label states the control's *purpose* and never changes; the
// on/off track + accent vs muted color show its current state. Keep it that way
// — a label that changes with the state ("Used" / "Not used") reads as a
// factual status rather than a switch. One label on every surface that shows
// the switch (the application page and the Documents artifacts list), so the
// two can't describe the same flag differently.
// The switch alone decides whether this answer feeds future drafting
// (independent of whether it's been used), so it renders on every artifact.
const SWITCH_LABEL = "Reuse when drafting";

const SwitchButton = styled.button<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 8px 2px 6px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  background: ${({ theme, $on }) => ($on ? theme.colors.bgMuted : "transparent")};
  color: ${({ theme, $on }) => ($on ? theme.colors.accent : theme.colors.textSubtle)};
  border: 1px solid
    ${({ theme, $on }) => ($on ? theme.colors.border : theme.colors.border)};
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

const SwitchTrack = styled.span<{ $on: boolean }>`
  position: relative;
  display: inline-block;
  width: 18px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 999px;
  background: ${({ theme, $on }) => ($on ? theme.colors.accent : theme.colors.textSubtle)};
  transition: background 0.15s ease;
`;

const SwitchKnob = styled.span<{ $on: boolean }>`
  position: absolute;
  top: 1px;
  left: ${({ $on }) => ($on ? "9px" : "1px")};
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.bgPanel};
  transition: left 0.15s ease;
`;

export function ReuseSwitch({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SwitchButton
      type="button"
      $on={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={
        on
          ? "Hank draws on this when drafting new cover letters and answers. Click to stop (the text stays)."
          : "Hank won't reuse this when drafting. Click to include it."
      }
      aria-pressed={on}
    >
      <SwitchTrack $on={on}>
        <SwitchKnob $on={on} />
      </SwitchTrack>
      {SWITCH_LABEL}
    </SwitchButton>
  );
}

// Remove control with a one-step "are you sure?" guard. When the artifact has
// text that would be lost, the first click arms an inline Delete? / Cancel
// confirm; an empty draft removes immediately (nothing to lose). Shared by the
// job-page editors and the read-only Documents list so the confirm behaves
// identically on both surfaces.
const ConfirmRow = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`;

const ConfirmPrompt = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
`;

export function ConfirmRemoveButton({
  hasText,
  onRemove,
  label = "Remove",
  title,
}: {
  hasText: boolean;
  onRemove: () => void;
  label?: string;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  if (armed) {
    return (
      <ConfirmRow>
        <ConfirmPrompt>Delete?</ConfirmPrompt>
        <DangerInlineButton
          onClick={() => {
            setArmed(false);
            onRemove();
          }}
        >
          Yes
        </DangerInlineButton>
        <InlineButton onClick={() => setArmed(false)}>Cancel</InlineButton>
      </ConfirmRow>
    );
  }
  return (
    <DangerInlineButton
      onClick={() => (hasText ? setArmed(true) : onRemove())}
      aria-label={title ?? label}
      title={title}
    >
      {label}
    </DangerInlineButton>
  );
}

type ArtifactPatch = {
  coverLetter?: string | null;
  shortAnswers?: ShortAnswer[] | null;
  coverLetterReuse?: boolean;
  shortAnswersReuse?: (boolean | null)[] | null;
};

// Exported so non-editing surfaces (the read-only Documents jobs list) can flip
// the reuse switch through the same PATCH path without re-rendering the editors.
export async function patchJobInteraction(
  jobId: string,
  body: ArtifactPatch,
): Promise<FocusedJobView | null> {
  // Admin view-session mode is read-only — short-circuit to avoid a wasted
  // round-trip and a misleading "save failed" toast.
  if (useChatStore.getState().impersonateSessionId) return null;
  const res = await fetch(`/api/jobs/${jobId}/interaction`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
  return (await res.json()) as FocusedJobView;
}

// Build the full parallel reuse array (length = saved answer count) with one
// index flipped to an explicit boolean. Preserves every other index's existing
// value (null ⇒ derive-from-used stays null). Shared by the job-page editor and
// the Documents read-only list so the stored shape stays identical.
export function buildShortAnswersReuse(
  current: (boolean | null)[] | null,
  savedLen: number,
  index: number,
  next: boolean,
): (boolean | null)[] {
  const arr: (boolean | null)[] = Array.from({ length: savedLen }, (_, idx) => {
    const cur = current?.[idx];
    return cur == null ? null : cur;
  });
  if (index >= 0 && index < arr.length) arr[index] = next;
  return arr;
}

// Effective on-state of the "use when drafting" switch for a single artifact.
// Plain boolean now (null ⇒ off) — no usedAt-derive. The switch turns on only
// when the user marks it reusable (copy / edit / flip); a Hank draft is off.
export function effectiveReuse(reuse: boolean | null | undefined): boolean {
  return reuse === true;
}
