"use client";

import { useMemo, useState } from "react";

import { useChatStore } from "@/lib/chatStore";

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
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

type Props = { payload: CompanyChecklistPayload };

export function CompanyChecklistWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(payload.suggestions.map((s) => s.name)),
  );
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

  async function submit(includeAll: boolean) {
    if (submitting) return;
    setSubmitting(true);
    // Carry each kept company's reasoning (→ hunter extraContext) and any
    // captured board URL (→ hunter candidateUrl) back through the submission,
    // not just the bare name — that's the fix for name collisions
    // resolving to the wrong company.
    const kept = payload.suggestions.filter(
      (s) => includeAll || picked.has(s.name),
    );
    const picks = kept.map((s) => ({
      name: s.name,
      context: s.reasoning,
      url: s.url,
    }));
    const label =
      picks.length === 0
        ? "[None of these]"
        : `[Picked: ${kept.map((s) => s.name).join(", ")}]`;
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "company_checklist", picked: picks },
          label,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const title = "Companies to add";

  return (
    <WidgetShell
      title={title}
      minimizable
      disabled={submitting}
      minimizedSummary={`${title} · ${payload.suggestions.length}`}
      footer={
        <ButtonRow>
          <SecondaryButton onClick={() => submit(false)} disabled={submitting}>
            {pickedList.length === 0
              ? "None of these"
              : `Add ${pickedList.length}`}
          </SecondaryButton>
        </ButtonRow>
      }
    >
      <Meta>Uncheck any you don't want, then confirm.</Meta>
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
