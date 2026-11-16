import { useEffect, useRef, useState } from "react";

import type { MessageView } from "@/client/chatStore";

import type { ActivePanel } from "./storeTypes";

// The scrollback's pin-to-bottom + load-older behaviour. `pinnedToBottomRef`
// and `setShowScrollToBottom` are returned because sending from the composer
// re-pins the view.
export function useChatScroll({
  messages,
  activePanel,
  hasMoreMessages,
  loadingOlder,
  loadOlderMessages,
}: {
  messages: MessageView[];
  activePanel: ActivePanel;
  hasMoreMessages: boolean;
  loadingOlder: boolean;
  loadOlderMessages: () => Promise<void>;
}) {
  // Mirrors !pinnedToBottomRef.current as state so the jump-to-bottom button
  // can render. Kept separate from the ref so the auto-scroll effect and
  // onScroll handler can act on pin status synchronously without waiting for
  // a re-render.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // True when the user is at (or very near) the bottom — that's when we want
  // streaming deltas to keep the view pinned. Flips to false the moment they
  // scroll up to read history, so we don't yank them back mid-read.
  const pinnedToBottomRef = useRef(true);
  const preserveScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }, [messages]);

  // On narrow viewports the chat pane mounts inside a `display: none` Pane
  // when the session loads with a focused entity (activePanel starts "right").
  // scrollHeight reads 0 there, so the [messages] effect above scrolls to a
  // no-op. When the user flips to the Chat tab, re-pin to the bottom.
  useEffect(() => {
    if (activePanel !== "chat") return;
    const el = scrollRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }, [activePanel]);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }

  useEffect(() => {
    const el = scrollRef.current;
    const saved = preserveScrollRef.current;
    if (!el || !saved) return;
    preserveScrollRef.current = null;
    const newScrollTop = el.scrollHeight - saved.scrollHeight + saved.scrollTop;
    el.scrollTop = newScrollTop;
  }, [messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Re-evaluate pinned state on every user scroll. The threshold tolerates
    // sub-pixel rounding and the gap that opens up between a streaming delta
    // landing and our effect re-pinning.
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distFromBottom < 40;
    pinnedToBottomRef.current = pinned;
    setShowScrollToBottom(!pinned);

    if (el.scrollTop > 80) return;
    if (!hasMoreMessages || loadingOlder) return;
    preserveScrollRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    void loadOlderMessages();
  }

  return {
    scrollRef,
    showScrollToBottom,
    setShowScrollToBottom,
    pinnedToBottomRef,
    scrollToBottom,
    onScroll,
  };
}
