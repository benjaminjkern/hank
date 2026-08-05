"use client";

import { useState } from "react";

import { useChatStore } from "@/lib/chatStore";

import {
  ButtonRow,
  Meta,
  PrimaryButton,
  SecondaryButton,
} from "../../sharedStyles";
import {
  buildWidgetSubmissionMessage,
  type ConfirmReviveCompanyPayload,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

type Props = { payload: ConfirmReviveCompanyPayload };

export function ConfirmReviveCompanyWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [submitting, setSubmitting] = useState(false);

  async function answer(value: "yes" | "no") {
    if (submitting) return;
    setSubmitting(true);
    const label =
      value === "yes" ? "[Revive and continue]" : "[Leave it set aside]";
    try {
      await send(
        buildWidgetSubmissionMessage(
          {
            kind: "confirm_revive_company",
            companyId: payload.companyId,
            answer: value,
          },
          label,
          { companyName: payload.companyName ?? "" },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WidgetShell
      title={`Revive ${payload.companyName ?? "this company"}?`}
      footer={
        <ButtonRow>
          <SecondaryButton onClick={() => answer("no")} disabled={submitting}>
            Not now
          </SecondaryButton>
          <PrimaryButton onClick={() => answer("yes")} disabled={submitting}>
            Revive
          </PrimaryButton>
        </ButtonRow>
      }
    >
      <Meta>{payload.reasoning}</Meta>
    </WidgetShell>
  );
}
