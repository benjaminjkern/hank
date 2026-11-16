"use client";

import { useState, useRef, type KeyboardEvent, type ChangeEvent } from "react";

import { useChatStore } from "@/client/chatStore";
import { NEGOTIATION_PANELS, type NegotiationPanel } from "@/shared/panelMode";

import { DropOverlay } from "../DropOverlay";

import { ChatHero } from "./ChatHero";
import { ComposerInputBar } from "./ComposerInputBar";
import { Composer, Root, Spacer } from "./layoutStyles";
import { MessageList } from "./MessageList";
import { PanelEditChips } from "./PanelEditChips";
import { PendingAttachmentChips } from "./PendingAttachmentChips";
import { RunNotice } from "./RunNotice";
import { useChatScroll } from "./useChatScroll";
import { useComposerText } from "./useComposerText";
import { useComposerTextarea } from "./useComposerTextarea";
import { useFileDragDrop } from "./useFileDragDrop";
import { useHopHankDance } from "./useHopHankDance";
import { useWidgetOverlayHeight } from "./useWidgetOverlayHeight";

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const streaming = useChatStore((s) => s.streaming);
  const streamInterrupted = useChatStore((s) => s.streamInterrupted);
  const serverRunActive = useChatStore((s) => s.serverRunActive);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const pendingPanelEdits = useChatStore((s) => s.pendingPanelEdits);
  // Both halves of the chip come from the same payload fetch, so a stale name
  // beside a live count isn't reachable: `newChat` is the only thing that drops
  // a viewed payload, and it zeroes the counts in the same set().
  const boardScope = useChatStore((s) => s.viewedBoard?.companyName ?? null);
  // The role AND the company: a job title alone ("Senior Software Engineer") is
  // the one thing on this screen that doesn't identify anything.
  const applicationScope = useChatStore((s) =>
    s.viewedApplication
      ? `${s.viewedApplication.jobTitle} @ ${s.viewedApplication.companyName}`
      : null,
  );
  const panelScope: Record<NegotiationPanel, string | null> = {
    "shortlist-board": boardScope,
    application: applicationScope,
    // The discovery list is every company the last search proposed — there is
    // no one subject to name.
    discovery: null,
  };
  const discardPanelEdits = useChatStore((s) => s.discardPanelEdits);
  // Which chip has its × armed. One at a time is enough — arming is a transient
  // gesture aimed at a specific chip — and it resets on its own when that
  // surface's count reaches zero.
  const [discarding, setDiscarding] = useState<NegotiationPanel | null>(null);
  const pendingPanelTotal = NEGOTIATION_PANELS.reduce(
    (n, panel) => n + pendingPanelEdits[panel],
    0,
  );
  const stageFiles = useChatStore((s) => s.stageFiles);
  const removePending = useChatStore((s) => s.removePending);
  const activePanel = useChatStore((s) => s.activePanel);
  // The blocking modal is the canonical "can the user chat?" signal — when
  // it's up the composer disables (defense in depth — the backdrop already
  // intercepts clicks). Reading from store rather than a server-rendered
  // prop means dismissing the modal after a successful key save unblocks
  // the composer on the same tick, no page refresh required.
  const apiKeyBlocker = useChatStore((s) => s.apiKeyBlocker);
  // Admin view-session mode is read-only — composer disabled, no Send / Stop /
  // upload paths. Same gate covers the chip widget below.
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const canChat = apiKeyBlocker === null && !readOnly;

  const [text, setText] = useComposerText();
  const { dragDepth, onDragEnter, onDragOver, onDragLeave, onDrop } =
    useFileDragDrop(stageFiles);
  const { animIndex, animTick, pickNextAnim } = useHopHankDance();
  const {
    scrollRef,
    showScrollToBottom,
    setShowScrollToBottom,
    pinnedToBottomRef,
    scrollToBottom,
    onScroll,
  } = useChatScroll({
    messages,
    activePanel,
    hasMoreMessages,
    loadingOlder,
    loadOlderMessages,
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useComposerTextarea(text);

  const anyUploading = pendingAttachments.some((p) => p.status === "uploading");
  const anyUploaded = pendingAttachments.some((p) => p.status === "uploaded");
  const busy = streaming || anyUploading;
  // Panel changes are sendable on their own — that's how the user hands a batch
  // of them to Hank without typing anything, on any of the three surfaces.
  const canSend =
    canChat &&
    !busy &&
    (Boolean(text.trim()) || anyUploaded || pendingPanelTotal > 0);

  function submit() {
    if (!canSend) return;
    const t = text.trim();
    setText("");
    // Sending implies "I want to see the response" — snap back even if the
    // user had scrolled up while composing.
    pinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    void send(t);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    stageFiles(Array.from(files));
    e.target.value = "";
  }

  const isEmpty = messages.length === 0;

  const { widgetHeight, widgetSlotRef } = useWidgetOverlayHeight(isEmpty);

  return (
    <Root
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isEmpty && <Spacer key="spacer-top" />}
      {isEmpty && <ChatHero key="hero" />}
      {!isEmpty && (
        <MessageList
          key="messages"
          messages={messages}
          streaming={streaming}
          loadingOlder={loadingOlder}
          scrollRef={scrollRef}
          onScroll={onScroll}
          showScrollToBottom={showScrollToBottom}
          scrollToBottom={scrollToBottom}
          widgetHeight={widgetHeight}
          widgetSlotRef={widgetSlotRef}
        />
      )}
      <RunNotice
        serverRunActive={serverRunActive}
        streamInterrupted={streamInterrupted}
        streaming={streaming}
      />
      <Composer key="composer" $centered={isEmpty}>
        <PanelEditChips
          pendingPanelEdits={pendingPanelEdits}
          panelScope={panelScope}
          discarding={discarding}
          setDiscarding={setDiscarding}
          discardPanelEdits={discardPanelEdits}
        />
        <PendingAttachmentChips
          pendingAttachments={pendingAttachments}
          removePending={removePending}
        />
        <ComposerInputBar
          fileRef={fileRef}
          onFile={onFile}
          inputRef={inputRef}
          text={text}
          setText={setText}
          onKey={onKey}
          submit={submit}
          stop={stop}
          streaming={streaming}
          canChat={canChat}
          canSend={canSend}
          readOnly={readOnly}
          anyUploading={anyUploading}
          hasPendingAttachments={pendingAttachments.length > 0}
          animIndex={animIndex}
          animTick={animTick}
          pickNextAnim={pickNextAnim}
        />
      </Composer>
      {isEmpty && <Spacer key="spacer-bottom" />}
      {dragDepth > 0 && <DropOverlay />}
    </Root>
  );
}
