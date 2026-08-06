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
  type AddMoreCompaniesPayload,
} from "../../types";
import { WidgetShell } from "../../WidgetShell";

type Props = { payload: AddMoreCompaniesPayload };

export function AddMoreCompaniesWidget({ payload }: Props) {
  const send = useChatStore((s) => s.send);
  const [submitting, setSubmitting] = useState(false);

  async function answer(value: "yes" | "no") {
    if (submitting) return;
    setSubmitting(true);
    const label = value === "yes" ? "[Add more]" : "[Done adding]";
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "add_more_companies", answer: value },
          label,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const added = payload.addedThisBatch;

  return (
    <WidgetShell
      title="Add more?"
      minimizable
      disabled={submitting}
      minimizedSummary="Add more?"
      footer={
        <ButtonRow>
          <SecondaryButton
            onClick={() => void answer("no")}
            disabled={submitting}
          >
            Done
          </SecondaryButton>
          <PrimaryButton
            onClick={() => void answer("yes")}
            disabled={submitting}
          >
            Add more
          </PrimaryButton>
        </ButtonRow>
      }
    >
      <Meta>
        {added.length === 0
          ? "Nothing added this round."
          : `Added: ${added.join(", ")}.`}{" "}
        Want to keep going or wrap up?
      </Meta>
    </WidgetShell>
  );
}
