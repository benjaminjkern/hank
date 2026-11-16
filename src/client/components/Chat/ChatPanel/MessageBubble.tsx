import { memo, useMemo } from "react";
import styled from "styled-components";

import type { MessageView } from "@/client/chatStore";

import {
  ShortlistCommitCard,
  tryParseShortlistCommit,
} from "../ShortlistCommitCard";
import {
  WidgetResponseCard,
  tryParseWidgetResponse,
} from "../widgets/WidgetResponseCard";

import { UserText } from "./messageTextStyles";
import { SegmentView } from "./SegmentView";

const Bubble = styled.div<{ $role: "user" | "assistant" }>`
  align-self: ${({ $role }) => ($role === "user" ? "flex-end" : "flex-start")};
  max-width: 720px;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  background: ${({ $role, theme }) =>
    $role === "user" ? theme.colors.bgHover : theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  word-wrap: break-word;
  font-size: 14px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.text};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const BubbleAttachments = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs};
`;

const BubbleAttachment = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
`;

// Small inline pill rendered under a cut-off assistant message (Stop press,
// dropped connection, or mid-stream error — the stoppedByUser flag covers all
// three). Neutral/muted tone — the partial is saved and Hank can continue.
const StoppedPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 999px;
  width: fit-content;
`;

// Memoized so that re-renders of ChatPanel triggered by typing in the
// composer, or by the scroll-button visibility toggle, don't re-render every
// bubble in the list (which would re-parse every assistant ReactMarkdown
// block). The `message` prop is referentially stable from zustand, so the
// shallow compare is a no-op except for the actually-changed bubble during
// streaming. `streamingPlaceholder` is false for all but the last bubble, so
// streaming flips don't ripple through earlier messages either.
export const MessageBubble = memo(function MessageBubble({
  message,
  streamingPlaceholder,
}: {
  message: MessageView;
  streamingPlaceholder: boolean;
}) {
  // Single-text-segment user messages may be a widget submission (the
  // <!--widget-response:…--> marker) or the legacy <!--shortlist-commit:…-->
  // recap. Both render as a standalone card replacing the bubble, so the raw
  // marker never paints. widget-response is the live path; shortlist-commit is
  // replay-only for pre-2026-06-12 history.
  const singleUserText = useMemo(
    () =>
      message.role === "user" &&
      message.segments.length === 1 &&
      message.segments[0].kind === "text"
        ? message.segments[0].text
        : null,
    [message.role, message.segments],
  );
  const widgetResponseParsed = useMemo(
    () => (singleUserText ? tryParseWidgetResponse(singleUserText) : null),
    [singleUserText],
  );
  const commitParsed = useMemo(
    () => (singleUserText ? tryParseShortlistCommit(singleUserText) : null),
    [singleUserText],
  );

  // Skip rendering bubbles whose only content is widget segments — widgets
  // render via PipelineWidgetSlot / ShortlistProposalWidget above the
  // composer, not inline. Without this, the bubble shows up as an empty
  // box on refresh. The segment is still in `message.segments` (so
  // PipelineWidgetSlot can find it); we just don't paint the chat row.
  const isWidgetOnly =
    message.role === "assistant" &&
    message.segments.length > 0 &&
    message.segments.every((s) => s.kind === "widget");
  if (isWidgetOnly) {
    return null;
  }

  // Skip a finished assistant turn with nothing renderable — no segments, or only
  // empty/whitespace text — which would otherwise paint a blank bubble that
  // survives a refresh (the Snowflake report). Guarded so a still-streaming turn
  // (shows "…") and a stopped-by-user turn (shows the pill) still render.
  const isEmptyAssistant =
    message.role === "assistant" &&
    !streamingPlaceholder &&
    !message.stoppedByUser &&
    (!message.attachments || message.attachments.length === 0) &&
    message.segments.every(
      (s) => s.kind === "text" && s.text.trim().length === 0,
    );
  if (isEmptyAssistant) {
    return null;
  }

  if (widgetResponseParsed) {
    return <WidgetResponseCard parsed={widgetResponseParsed} />;
  }

  if (commitParsed) {
    return (
      <>
        <ShortlistCommitCard payload={commitParsed} />
        {commitParsed.reason && (
          <Bubble $role="user">
            <UserText>Reason: {commitParsed.reason}</UserText>
          </Bubble>
        )}
      </>
    );
  }

  return (
    <Bubble $role={message.role}>
      {message.attachments && message.attachments.length > 0 && (
        <BubbleAttachments>
          {message.attachments.map((a) => (
            <BubbleAttachment key={a.attachmentId}>
              📎 {a.fileName}
            </BubbleAttachment>
          ))}
        </BubbleAttachments>
      )}
      {message.panelEdits && message.panelEdits.length > 0 && (
        <BubbleAttachments>
          {message.panelEdits.map((e, i) => (
            <BubbleAttachment key={i}>
              ☰ {e.title}
              {e.verdict ? ` → ${e.verdict.toLowerCase()}` : ""}
            </BubbleAttachment>
          ))}
        </BubbleAttachments>
      )}
      {message.segments.length === 0 &&
        message.role === "assistant" &&
        streamingPlaceholder && <UserText>…</UserText>}
      {message.segments.map((seg, i) => (
        <SegmentView key={i} segment={seg} role={message.role} />
      ))}
      {message.role === "assistant" && message.stoppedByUser && (
        // Cause-neutral: the stoppedByUser flag is set for a Stop press, a
        // dropped connection, and a genuine mid-stream error alike — all cut the
        // reply off and save the partial. "Interrupted" reads true for all three.
        <StoppedPill>Response interrupted</StoppedPill>
      )}
    </Bubble>
  );
});
