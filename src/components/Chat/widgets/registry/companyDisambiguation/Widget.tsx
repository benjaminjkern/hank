"use client";

import { useState } from "react";
import styled from "styled-components";

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
  type CompanyDisambiguationPayload,
  type DisambiguationResolution,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

type Props = { payload: CompanyDisambiguationPayload };

// Sentinel selection meaning "none of these — leave it off my list".
const SKIP = -1;

const Group = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  & + & {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
`;

const GroupHeader = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
`;

export function CompanyDisambiguationWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [submitting, setSubmitting] = useState(false);
  // companyId → chosen candidate index (or SKIP). Default to the first
  // candidate so the common single-collision case is one click to confirm.
  const [choice, setChoice] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const c of payload.companies) init[c.companyId] = 0;
    return init;
  });

  function pick(companyId: string, index: number) {
    setChoice((prev) => ({ ...prev, [companyId]: index }));
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    const resolved: DisambiguationResolution[] = [];
    const labels: string[] = [];
    for (const company of payload.companies) {
      const idx = choice[company.companyId] ?? 0;
      if (idx === SKIP) continue;
      const cand = company.candidates[idx];
      if (!cand) continue;
      resolved.push({
        companyId: company.companyId,
        chosenUrl: cand.chosenUrl,
        canonicalName: cand.canonicalName,
        shortDescription: cand.shortDescription,
      });
      labels.push(cand.canonicalName);
    }
    const label =
      resolved.length === 0
        ? "[None matched]"
        : `[Picked: ${labels.join(", ")}]`;
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "company_disambiguation", resolved },
          label,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting;
  const total = payload.companies.length;

  return (
    <WidgetShell
      title={total === 1 ? "Which company?" : "Which companies?"}
      minimizable
      disabled={disabled}
      minimizedSummary={`Disambiguate · ${total}`}
      footer={
        <ButtonRow>
          <SecondaryButton onClick={submit} disabled={disabled}>
            Confirm
          </SecondaryButton>
        </ButtonRow>
      }
    >
      <Meta>
        {total === 1
          ? "That name matches more than one company — pick the one you meant."
          : "Some names matched more than one company — pick the one you meant for each."}
      </Meta>
      {payload.companies.map((company) => (
        <Group key={company.companyId}>
          {total > 1 && <GroupHeader>“{company.name}”</GroupHeader>}
          <SuggestionList>
            {company.candidates.map((cand, i) => (
              <SuggestionRow key={cand.chosenUrl}>
                <SuggestionCheckbox
                  type="radio"
                  name={`disambig-${company.companyId}`}
                  checked={(choice[company.companyId] ?? 0) === i}
                  onChange={() => pick(company.companyId, i)}
                  disabled={disabled}
                />
                <SuggestionBody>
                  <SuggestionName>{cand.canonicalName}</SuggestionName>
                  <SuggestionReason>{cand.shortDescription}</SuggestionReason>
                </SuggestionBody>
              </SuggestionRow>
            ))}
            <SuggestionRow>
              <SuggestionCheckbox
                type="radio"
                name={`disambig-${company.companyId}`}
                checked={(choice[company.companyId] ?? 0) === SKIP}
                onChange={() => pick(company.companyId, SKIP)}
                disabled={disabled}
              />
              <SuggestionBody>
                <SuggestionName>Neither — none of these</SuggestionName>
                <SuggestionReason>
                  Leave it off your list for now.
                </SuggestionReason>
              </SuggestionBody>
            </SuggestionRow>
          </SuggestionList>
        </Group>
      ))}
    </WidgetShell>
  );
}
