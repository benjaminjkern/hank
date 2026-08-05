"use client";

// The application page: everything the form asks for, in form order, each with
// room to actually write in.
//
// Every item is listed whether or not anything is written for it — a question
// Hank passed over is one the user can still answer, and one they can't see is
// one they can't fill in. Editing persists on blur and never wakes Hank; the
// change rides their next message (or the Send-my-changes button), which is
// also what re-baselines the "edited" marker.

import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { buildWidgetSubmissionMessage } from "@/components/Chat/widgets/types";
import { useChatStore } from "@/lib/chatStore";
import type {
  ApplicationItem,
  ApplicationItemStatus,
  ApplicationView as ApplicationViewPayload,
} from "@/server/views/application";

const Root = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xl};
  max-width: 780px;
`;

// "← Documents" back link, shown only when this page was opened from the
// Documents artifacts list. Routes back to the same sub-page / scroll the user
// left, refetching so edits made here show up on return.
const BackLink = styled.button`
  align-self: flex-start;
  background: transparent;
  padding: 2px 6px 2px 4px;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const Header = styled.header`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const TitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const H2 = styled.h2`
  font-size: 16px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
`;

const Note = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

const ActionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.sm};
`;

const PillButton = styled.button<{ $primary?: boolean }>`
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  border: 1px solid ${({ theme }) => theme.colors.accent};
  color: ${({ theme, $primary }) =>
    $primary ? theme.colors.bg : theme.colors.accent};
  background: ${({ theme, $primary }) =>
    $primary ? theme.colors.accent : "transparent"};

  &:hover:not(:disabled) {
    opacity: 0.85;
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const LinkOut = styled.a`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.accent};
  align-self: center;
`;

const Item = styled.section<{ $edited: boolean }>`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => theme.space.lg};
  border: 1px solid
    ${({ theme, $edited }) =>
      $edited ? theme.colors.accent : theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
`;

const ItemHead = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`;

const ItemLabel = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.45;
  min-width: 0;
`;

const Tag = styled.span<{ $tone: "muted" | "accent" }>`
  flex-shrink: 0;
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  white-space: nowrap;
  color: ${({ theme, $tone }) =>
    $tone === "accent" ? theme.colors.accent : theme.colors.textSubtle};
`;

const SubLabel = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  line-height: 1.5;
`;

// Tall enough to write a real cover letter in, and it grows with the text —
// the small fixed boxes were the reason drafts felt like form fields rather
// than something you'd actually work on.
const Editor = styled.textarea<{ $tall: boolean }>`
  width: 100%;
  min-height: ${({ $tall }) => ($tall ? "320px" : "120px")};
  resize: vertical;
  font: inherit;
  font-size: 14px;
  line-height: 1.65;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.md};

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  &::placeholder {
    color: ${({ theme }) => theme.colors.textSubtle};
  }
`;

const ItemFoot = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  min-height: 18px;
`;

const SaveState = styled.span<{ $tone: "idle" | "saving" | "saved" | "error" }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $tone }) =>
    $tone === "error" ? theme.colors.danger : theme.colors.textSubtle};
  opacity: ${({ $tone }) => ($tone === "idle" ? 0 : 1)};
  transition: opacity 0.2s;
`;

const ReuseToggle = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
`;

const Empty = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.6;
`;

const STATUS_TAG: Record<ApplicationItemStatus, string | null> = {
  written_by_you: "yours",
  drafted: "hank's draft",
  needs_you: "needs you",
  empty: null,
};

const PLACEHOLDER: Record<ApplicationItemStatus, string> = {
  written_by_you: "",
  drafted: "",
  needs_you:
    "Tell Hank about this in chat and he'll shape it with you — or write it here.",
  empty: "Nothing written yet. Write it here, or ask Hank to draft it.",
};

export function ApplicationView({
  application,
}: {
  application: ApplicationViewPayload;
}) {
  const send = useChatStore((s) => s.send);
  const streaming = useChatStore((s) => s.streaming);
  const readOnly = !!useChatStore((s) => s.impersonateSessionId);
  const returnFromDocuments = useChatStore((s) => s.documentsNav.returnFromJob);
  const backToDocuments = useChatStore((s) => s.backToDocuments);
  const pending = application.pendingEditCount;

  return (
    <Root>
      <Header>
        {returnFromDocuments && (
          <BackLink onClick={() => backToDocuments()}>← Documents</BackLink>
        )}
        <TitleRow>
          <H2>
            {application.jobTitle} — {application.companyName}
          </H2>
        </TitleRow>
        <Note>
          {application.submitted
            ? "You've submitted this one. It stays here to read or reuse — edits from now on are just for you, and Hank won't be asked to look again."
            : "Everything this application asks for is below. Edit anything — what you change rides your next message so Hank knows before he touches it again."}
        </Note>
        {!readOnly && (
          <ActionRow>
            {!application.submitted && (
              <>
                <PillButton
                  disabled={streaming}
                  onClick={() =>
                    void send(
                      pending > 0
                        ? "I've made some changes to the application — take a look and tell me what you think."
                        : "The application reads right to me as it stands.",
                    )
                  }
                >
                  {pending > 0 ? "Send my changes" : "Looks good to me"}
                </PillButton>
                <PillButton
                  $primary
                  disabled={streaming}
                  onClick={() =>
                    void send(
                      buildWidgetSubmissionMessage(
                        {
                          kind: "confirm_application_submit",
                          jobId: application.jobId,
                        },
                        "[I submitted ✓]",
                        {
                          jobTitle: application.jobTitle,
                          companyName: application.companyName,
                        },
                      ),
                    )
                  }
                >
                  I submitted ✓
                </PillButton>
              </>
            )}
            {application.postingUrl && (
              <LinkOut
                href={application.postingUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open the posting ↗
              </LinkOut>
            )}
          </ActionRow>
        )}
      </Header>

      {application.formUnreadable && application.items.length === 0 ? (
        <Empty>
          Hank couldn&apos;t read this application form — its page is
          login-gated, on an ATS he can&apos;t parse, or there&apos;s no
          application link on file. Tell him what it asks in chat and he&apos;ll
          add each question here.
        </Empty>
      ) : application.items.length === 0 ? (
        <Empty>
          This form has no written questions — just the standard fields you fill
          in directly on the posting.
        </Empty>
      ) : (
        application.items.map((item) => (
          <ApplicationItemCard
            key={item.id}
            jobId={application.jobId}
            item={item}
            readOnly={readOnly}
          />
        ))
      )}
    </Root>
  );
}

function ApplicationItemCard({
  jobId,
  item,
  readOnly,
}: {
  jobId: string;
  item: ApplicationItem;
  readOnly: boolean;
}) {
  const replaceViewedApplication = useChatStore(
    (s) => s.replaceViewedApplication,
  );
  const [text, setText] = useState(item.text ?? "");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const savedRef = useRef(item.text ?? "");

  // Follow the server when it changes underneath us (Hank drafted, or a
  // revision landed) — but never clobber what's being typed right now.
  useEffect(() => {
    const incoming = item.text ?? "";
    if (incoming !== savedRef.current) {
      savedRef.current = incoming;
      setText(incoming);
    }
  }, [item.text]);

  async function persist(patch: { text?: string; reuse?: boolean }) {
    if (readOnly) return;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/jobs/${jobId}/application`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, ...patch }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const fresh = (await res.json()) as ApplicationViewPayload;
      if (patch.text !== undefined) savedRef.current = patch.text;
      replaceViewedApplication(fresh);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch {
      setSaveState("error");
    }
  }

  const tag = STATUS_TAG[item.status];
  return (
    <Item $edited={item.edited}>
      <ItemHead>
        <ItemLabel>
          {item.label}
          {item.required && <SubLabel>Required</SubLabel>}
        </ItemLabel>
        {item.edited ? (
          <Tag $tone="accent">edited · not sent yet</Tag>
        ) : (
          tag && <Tag $tone="muted">{tag}</Tag>
        )}
      </ItemHead>

      {item.source === "user" && (
        <SubLabel>
          Added by hand — Hank couldn&apos;t read this one off the form.
        </SubLabel>
      )}
      {item.note && <SubLabel>{item.note}</SubLabel>}

      <Editor
        $tall={item.kind === "cover_letter"}
        value={text}
        readOnly={readOnly}
        placeholder={PLACEHOLDER[item.status]}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== savedRef.current) void persist({ text });
        }}
      />

      <ItemFoot>
        {item.text ? (
          <ReuseToggle>
            <input
              type="checkbox"
              checked={item.reuse === true}
              disabled={readOnly}
              onChange={(e) => void persist({ reuse: e.target.checked })}
            />
            Reuse this when drafting future applications
          </ReuseToggle>
        ) : (
          <span />
        )}
        <SaveState $tone={saveState}>
          {saveState === "saving"
            ? "saving…"
            : saveState === "saved"
              ? "saved"
              : saveState === "error"
                ? "couldn't save"
                : ""}
        </SaveState>
      </ItemFoot>
    </Item>
  );
}
