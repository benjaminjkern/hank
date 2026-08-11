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

  const added = payload.addedThisBatch;
  const settled = added.length + (payload.passedCount ?? 0);

  async function answer(value: "yes" | "no") {
    if (submitting) return;
    setSubmitting(true);
    const label = value === "yes" ? "[Find more]" : "[Done adding]";
    try {
      await send(
        buildWidgetSubmissionMessage(
          { kind: "add_more_companies", answer: value, settled },
          label,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WidgetShell
      title={added.length > 0 ? `Added ${added.length}` : "Nothing added"}
      minimizable
      disabled={submitting}
      minimizedSummary="Done adding?"
      footer={
        <ButtonRow>
          <SecondaryButton
            onClick={() => void answer("yes")}
            disabled={submitting}
          >
            Find more
          </SecondaryButton>
          {/* Primary is LEAVING discovery: finishing an add should point at the
              work, not invite another lap. */}
          <PrimaryButton
            onClick={() => void answer("no")}
            disabled={submitting}
          >
            Done adding
          </PrimaryButton>
        </ButtonRow>
      }
    >
      <Meta>
        {added.length === 0
          ? "Nothing new landed this round."
          : `${added.join(", ")} ${added.length === 1 ? "is" : "are"} on your list.`}{" "}
        Ready to start working through them, or want more options first?
      </Meta>
    </WidgetShell>
  );
}
