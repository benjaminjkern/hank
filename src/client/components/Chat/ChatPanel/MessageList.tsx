import styled from "styled-components";

import type { MessageView } from "@/client/chatStore";
import { ClientErrorBoundary } from "@/client/components/ClientErrorBoundary";

import { PipelineWidgetSlot } from "../widgets";

import { MessageBubble } from "./MessageBubble";

import type { RefObject } from "react";

// Wrapper around the scroll container so absolutely-positioned overlays (the
// jump-to-bottom button) don't scroll with the message content. `flex: 1`
// makes it claim the leftover space in the Root column once messages exist,
// docking the composer at the bottom.
const MessagesArea = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
`;

const MessagesScroll = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: ${({ theme }) => theme.space.xl};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.lg};
`;

// Holds the sticky pipeline widget. Absolutely positioned so it overlays the
// bottom of the chat scroll (z-index above messages) rather than stealing
// layout height — MessagesScroll reserves bottom padding (= this overlay's
// measured height) so the latest message clears it. Capped at 70% of the chat
// area; `pointer-events: none` lets clicks fall through the side gutters to the
// chat, while the card inside re-enables them. Anchored to the bottom so it
// grows upward as the widget gets taller.
const WidgetOverlay = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  max-height: 70%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 0 ${({ theme }) => theme.space.xl};
  pointer-events: none;
`;

const ScrollToBottomButton = styled.button`
  position: absolute;
  z-index: 3;
  bottom: ${({ theme }) => theme.space.md};
  left: 50%;
  transform: translateX(-50%);
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);

  &:hover {
    color: ${({ theme }) => theme.colors.text};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const OlderLoader = styled.div`
  text-align: center;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: ${({ theme }) => theme.space.sm} 0;
`;

// Breathing room between the last message and the top of the sticky widget
// card when the scroll region reserves space for the overlay.
const WIDGET_CLEARANCE = 16;

// The non-empty chat: the scrollback, the jump-to-bottom button, and the sticky
// pipeline widget overlaid on the bottom of it. Scroll and overlay-height state
// live in ChatPanel (useChatScroll / useWidgetOverlayHeight) because sending a
// message from the composer re-pins the scroll.
export function MessageList({
  messages,
  streaming,
  loadingOlder,
  scrollRef,
  onScroll,
  showScrollToBottom,
  scrollToBottom,
  widgetHeight,
  widgetSlotRef,
}: {
  messages: MessageView[];
  streaming: boolean;
  loadingOlder: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  showScrollToBottom: boolean;
  scrollToBottom: () => void;
  widgetHeight: number;
  widgetSlotRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <MessagesArea>
      <MessagesScroll
        ref={scrollRef}
        onScroll={onScroll}
        style={
          widgetHeight
            ? { paddingBottom: widgetHeight + WIDGET_CLEARANCE }
            : undefined
        }
      >
        {loadingOlder && <OlderLoader>Loading older messages…</OlderLoader>}
        {messages.map((m, i) => (
          <MessageBubble
            key={m.id}
            message={m}
            streamingPlaceholder={streaming && i === messages.length - 1}
          />
        ))}
      </MessagesScroll>
      {showScrollToBottom && (
        <ScrollToBottomButton
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          title="Scroll to latest"
          style={widgetHeight ? { bottom: widgetHeight + 12 } : undefined}
        >
          ↓
        </ScrollToBottomButton>
      )}
      <WidgetOverlay ref={widgetSlotRef}>
        <ClientErrorBoundary component="ChatWidget">
          <PipelineWidgetSlot />
        </ClientErrorBoundary>
      </WidgetOverlay>
    </MessagesArea>
  );
}
