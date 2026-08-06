"use client";

// The checklist owns the BITS — which of these names, and nothing else. Why a
// batch was wrong is a sentence the user types in chat, which covers the whole
// list at once, reaches the next search as its direction, and lands in memory
// with the conversation around it. A per-row reason picker was a lossy
// re-encoding of that sentence, so there isn't one.

import { useMemo, useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";

import {
  ButtonRow,
  PrimaryButton,
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

// How this batch was found, written per-run by the search. It's the only line
// above the list, so it gets the readable muted tone rather than the dimmest
// one — it's the thing worth reading, not chrome.
const Provenance = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: 6px;
  line-height: 1.45;
`;

type Props = { payload: CompanyChecklistPayload };

export function CompanyChecklistWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(payload.suggestions.map((s) => s.name)),
  );
  const [submitting, setSubmitting] = useState(false);

  const pickedCount = useMemo(() => picked.size, [picked]);

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // `keep` is passed explicitly so "Skip all" doesn't have to round-trip
  // through a state update it would then race.
  async function submit(keep: Set<string>) {
    if (submitting) return;
    setSubmitting(true);
    // Carry each kept company's reasoning (→ hunter extraContext) and any
    // captured board URL (→ hunter candidateUrl), not just the bare name —
    // that's what stops a name collision resolving to the wrong company.
    const kept = payload.suggestions.filter((s) => keep.has(s.name));
    const picks = kept.map((s) => ({
      name: s.name,
      context: s.reasoning,
      url: s.url,
    }));
    const declined: DeclinedCompany[] = payload.suggestions
      .filter((s) => !keep.has(s.name))
      .map((s) => ({ name: s.name }));
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

  return (
    <WidgetShell
      title="Companies to add"
      minimizable
      disabled={submitting}
      minimizedSummary={`Companies to add · ${payload.suggestions.length}`}
      footer={
        <ButtonRow>
          {/* Every row starts checked, so declining the batch would otherwise
              cost one uncheck per name. */}
          <SecondaryButton
            onClick={() => void submit(new Set())}
            disabled={submitting}
          >
            Skip all
          </SecondaryButton>
          <PrimaryButton
            onClick={() => void submit(picked)}
            disabled={submitting || pickedCount === 0}
          >
            Add {pickedCount}
          </PrimaryButton>
        </ButtonRow>
      }
    >
      {payload.provenance && <Provenance>{payload.provenance}</Provenance>}
      <SuggestionList>
        {payload.suggestions.map((s) => (
          <SuggestionRow key={s.name}>
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
        ))}
      </SuggestionList>
    </WidgetShell>
  );
}
