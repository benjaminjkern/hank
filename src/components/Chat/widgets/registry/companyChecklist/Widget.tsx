"use client";

import { useMemo, useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import {
  COMPANY_SUGGESTION_DECLINE_REASONS,
  SUGGESTION_DECLINE_LABELS,
} from "@/server/entities/companies/companySuggestionInputs";

import {
  ButtonRow,
  Meta,
  SecondaryButton,
  SuggestionBody,
  SuggestionCheckbox,
  SuggestionList,
  SuggestionName,
  SuggestionReason,
  SuggestionRow,
} from "../../sharedStyles";
import {
  buildWidgetSubmissionMessage,
  type CompanyChecklistPayload,
  type DeclinedCompany,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

// The "why not" strip, revealed under a row the moment it's unchecked. Every
// part of it is optional — a bare uncheck is still recorded and still steers the
// next search. It's here because the checkbox alone carries one bit, and the
// reason a suggestion was wrong is the only thing that stops the next search
// making the same mistake with a different name.
const WhyRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 2px 0 4px 24px;
`;

const Chip = styled.button<{ $on: boolean }>`
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: pointer;
  border: 1px solid
    ${({ theme, $on }) => ($on ? theme.colors.accent : theme.colors.border)};
  color: ${({ theme, $on }) =>
    $on ? theme.colors.accent : theme.colors.textMuted};
  background: transparent;

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const NoteInput = styled.input`
  flex: 1;
  min-width: 140px;
  font: inherit;
  font-size: 11px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 6px;
  padding: 3px 8px;

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const SteerRow = styled.div`
  display: flex;
  gap: 6px;
  margin-top: 8px;
`;

const SteerInput = styled.input`
  flex: 1;
  font: inherit;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 6px;
  padding: 4px 8px;

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const Provenance = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-bottom: 6px;
  line-height: 1.45;
`;

type Props = { payload: CompanyChecklistPayload };

type Why = { reason?: string; note?: string };

export function CompanyChecklistWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(payload.suggestions.map((s) => s.name)),
  );
  const [why, setWhy] = useState<Record<string, Why>>({});
  const [steer, setSteer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const pickedList = useMemo(() => Array.from(picked), [picked]);

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function setReason(name: string, reason: string) {
    setWhy((prev) => {
      const cur = prev[name] ?? {};
      // Tapping the active chip clears it — the reason is optional, so
      // un-picking has to be possible.
      return {
        ...prev,
        [name]: { ...cur, reason: cur.reason === reason ? undefined : reason },
      };
    });
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    // Carry each kept company's reasoning (→ hunter extraContext) and any
    // captured board URL (→ hunter candidateUrl), not just the bare name —
    // that's what stops a name collision resolving to the wrong company.
    const kept = payload.suggestions.filter((s) => picked.has(s.name));
    const picks = kept.map((s) => ({
      name: s.name,
      context: s.reasoning,
      url: s.url,
    }));
    const declined: DeclinedCompany[] = payload.suggestions
      .filter((s) => !picked.has(s.name))
      .map((s) => ({
        name: s.name,
        ...(why[s.name]?.reason ? { reason: why[s.name].reason } : {}),
        ...(why[s.name]?.note?.trim()
          ? { note: why[s.name].note!.trim() }
          : {}),
      }));
    const label =
      picks.length === 0
        ? "[None of these]"
        : `[Picked: ${kept.map((s) => s.name).join(", ")}]`;
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "company_checklist", picked: picks, declined },
          label,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Re-steer the SEARCH rather than the results. Plain chat rather than a
  // submission: it's a new request, and Hank turns it into another
  // find_companies run with this as the direction.
  async function trySteer() {
    const text = steer.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      await send(`None of these are quite right — ${text}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WidgetShell
      title="Companies to add"
      minimizable
      disabled={submitting}
      minimizedSummary={`Companies to add · ${payload.suggestions.length}`}
      footer={
        <ButtonRow>
          <SecondaryButton onClick={() => void submit()} disabled={submitting}>
            {pickedList.length === 0
              ? "None of these"
              : `Add ${pickedList.length}`}
          </SecondaryButton>
        </ButtonRow>
      }
    >
      {payload.provenance && <Provenance>{payload.provenance}</Provenance>}
      <Meta>
        Uncheck any you don&apos;t want — say why if you like, and I&apos;ll
        stop surfacing that kind.
      </Meta>
      <SuggestionList>
        {payload.suggestions.map((s) => {
          const isDeclined = !picked.has(s.name);
          return (
            <div key={s.name}>
              <SuggestionRow>
                <SuggestionCheckbox
                  type="checkbox"
                  checked={picked.has(s.name)}
                  onChange={() => toggle(s.name)}
                  disabled={submitting}
                />
                <SuggestionBody>
                  <SuggestionName>{s.name}</SuggestionName>
                  <SuggestionReason>{s.reasoning}</SuggestionReason>
                </SuggestionBody>
              </SuggestionRow>
              {isDeclined && (
                <WhyRow>
                  {COMPANY_SUGGESTION_DECLINE_REASONS.filter(
                    (r) => r !== "OTHER",
                  ).map((r) => (
                    <Chip
                      key={r}
                      type="button"
                      $on={why[s.name]?.reason === r}
                      disabled={submitting}
                      onClick={() => setReason(s.name, r)}
                    >
                      {SUGGESTION_DECLINE_LABELS[r]}
                    </Chip>
                  ))}
                  <NoteInput
                    placeholder="or say why…"
                    value={why[s.name]?.note ?? ""}
                    disabled={submitting}
                    onChange={(e) =>
                      setWhy((prev) => ({
                        ...prev,
                        [s.name]: { ...prev[s.name], note: e.target.value },
                      }))
                    }
                  />
                </WhyRow>
              )}
            </div>
          );
        })}
      </SuggestionList>
      <SteerRow>
        <SteerInput
          placeholder="Want a different angle? Tell me what to look for instead…"
          value={steer}
          disabled={submitting}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void trySteer();
          }}
        />
        <SecondaryButton
          onClick={() => void trySteer()}
          disabled={submitting || !steer.trim()}
        >
          Search again
        </SecondaryButton>
      </SteerRow>
    </WidgetShell>
  );
}
