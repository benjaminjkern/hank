"use client";

import { useRef } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";

import { PanelTabs } from "./PanelTabs";

const Root = styled.div<{ $hasBanner: boolean }>`
  display: grid;
  grid-template-rows: ${({ theme, $hasBanner }) =>
    $hasBanner
      ? `auto ${theme.size.topBar} auto 1fr`
      : `${theme.size.topBar} auto 1fr`};
  height: 100dvh;
  background: ${({ theme }) => theme.colors.bg};
`;

const Body = styled.div<{ $rightCollapsed: boolean }>`
  // Pin to the final (1fr) row of the parent Root grid. Without an explicit
  // placement, on wide screens PanelTabs's \`Bar\` is \`display: none\` and CSS
  // Grid removes it from auto-placement entirely — so TopBar lands in row 1,
  // Body auto-places into row 2 (the \`auto\` row → 0 height), and the 1fr row
  // sits empty. Result: Body has no definite height, height: 100% collapses
  // down the chain, and the empty-state Hero+Composer bunch at the top instead
  // of vertically centering.
  //
  // Span the row explicitly with \`-2 / -1\` (second-to-last line → last line),
  // NOT a bare \`grid-row: -1\`. \`-1\` sets only the start line; the end defaults
  // to \`span 1\`, which lands Body in an *implicit* row BELOW the 1fr track. On
  // narrow viewports PanelTabs is visible and auto-places into row 2, so the
  // now-empty 1fr row eats all the free height and Body's content pins to the
  // bottom of the screen with a dead gap above it. \`-2 / -1\` targets the last
  // explicit track itself, which is the 1fr row in both the 3-row (no banner)
  // and 4-row (banner = admin view-session) cases.
  grid-row: -2 / -1;
  display: grid;
  grid-template-columns: ${({ $rightCollapsed }) =>
    $rightCollapsed ? "1fr 32px" : "1fr 1fr"};
  // Implicit row must be 1fr, not auto. Without this, the row sizes to its
  // tallest pane's intrinsic content height — short content (empty chat,
  // empty dashboard) leaves a big dead zone below the panes instead of the
  // panes filling all the way down. Panes' \`height: 100%\` then has nothing
  // definite to resolve against.
  grid-template-rows: 1fr;
  // Explicit height: 100% — same reasoning as on Pane. Lets Pane's
  // \`height: 100%\` resolve against a *specified* containing block, which
  // then lets ChatPanel Root's height: 100% resolve, which then lets the
  // flex spacers actually expand.
  height: 100%;
  min-height: 0;

  @media (max-width: ${({ theme }) => theme.breakpoints.narrow}) {
    grid-template-columns: 1fr;
  }
`;

const Pane = styled.section<{ $hideOnNarrow: boolean }>`
  // Explicit height: 100% so children's percentage heights resolve against a
  // *specified* containing block, not just an implicit grid-stretch one
  // (which some browsers treat as indefinite). Without this, ChatPanel's
  // \`height: 100%\` + flex spacers collapse to content height.
  height: 100%;
  min-height: 0;
  min-width: 0;
  border-left: 1px solid ${({ theme }) => theme.colors.border};

  &:first-child {
    border-left: none;
  }

  @media (max-width: ${({ theme }) => theme.breakpoints.narrow}) {
    border-left: none;
    display: ${({ $hideOnNarrow }) => ($hideOnNarrow ? "none" : "block")};
    grid-column: 1 / -1;
    grid-row: 1;
  }
`;

interface SplitLayoutProps {
  top: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
  // Optional strip rendered above TopBar. Used by /admin/session/[sessionId]
  // to flag read-only impersonation. When provided, the grid grows from 3 to
  // 4 rows; otherwise the layout is identical to before.
  banner?: React.ReactNode;
}

const SWIPE_MIN_DX = 60;
const SWIPE_AXIS_RATIO = 1.5;
const SWIPE_MAX_DURATION_MS = 500;
// Inlined rather than read from theme — matchMedia runs outside the React
// render, so we'd otherwise need to thread the theme through useTheme.
const NARROW_MAX_WIDTH = "900px";

export function SplitLayout({ top, left, right, banner }: SplitLayoutProps) {
  const rightCollapsed = useChatStore((s) => s.rightCollapsed);
  const activePanel = useChatStore((s) => s.activePanel);
  const setActivePanel = useChatStore((s) => s.setActivePanel);
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }

  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    if (typeof window === "undefined") return;
    // Swipe is narrow-only. Check at touchend so a mid-gesture resize
    // doesn't desync; no preventDefault means vertical scroll stays intact
    // and the dominant-axis check below filters scroll gestures out.
    if (!window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH})`).matches) return;

    const end = e.changedTouches[0];
    if (!end) return;
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    const dt = Date.now() - start.t;
    if (dt > SWIPE_MAX_DURATION_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_DX) return;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return;

    if (dx < 0 && activePanel === "chat") setActivePanel("right");
    else if (dx > 0 && activePanel === "right") setActivePanel("chat");
  }

  return (
    <Root $hasBanner={banner != null}>
      {banner}
      {top}
      <PanelTabs />
      <Body
        $rightCollapsed={rightCollapsed}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <Pane $hideOnNarrow={activePanel !== "chat"}>{left}</Pane>
        <Pane $hideOnNarrow={activePanel !== "right"}>{right}</Pane>
      </Body>
    </Root>
  );
}
