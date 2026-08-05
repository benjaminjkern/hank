"use client";

import { useState } from "react";

import { useChatStore } from "@/lib/chatStore";

import { ButtonRow, Meta, PrimaryButton } from "../../sharedStyles";
import {
  buildWidgetSubmissionMessage,
  type ConfirmApplicationSubmitPayload,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

type Props = { payload: ConfirmApplicationSubmitPayload };

export function ConfirmApplicationSubmitWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    const label = "[I submitted ✓]";
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "confirm_application_submit", jobId: payload.jobId },
          label,
          {
            jobTitle: payload.jobTitle ?? null,
            companyName: payload.companyName ?? null,
          },
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const subject = [payload.jobTitle, payload.companyName]
    .filter(Boolean)
    .join(" @ ");
  return (
    <WidgetShell
      title="Did you submit?"
      footer={
        <ButtonRow>
          <PrimaryButton onClick={confirm} disabled={submitting}>
            I submitted ✓
          </PrimaryButton>
        </ButtonRow>
      }
    >
      <Meta>
        {subject
          ? `Tap once you've submitted your application to ${subject}.`
          : "Tap once you've submitted your application."}
      </Meta>
    </WidgetShell>
  );
}
