import styled from "styled-components";

// Flex column. Empty state inserts two `<Spacer />`s (flex: 1) above + below
// the hero/composer block, vertically centering it. Non-empty state swaps the
// spacers out and gives MessagesArea `flex: 1` so it grows to fill while the
// composer docks naturally at the bottom. Stable keys on every child let the
// Composer reuse its mount across the swap (preserves textarea state).
//
// `height: 100%` resolves against the Pane (which sets explicit `height: 100%`
// + `min-height: 0`) so the chain is reliable. Don't substitute `100dvh - topBar`
// — on narrow viewports SplitLayout adds a PanelTabs row above the body, and a
// hardcoded `100dvh - topBar` ignores it, leaving the panel taller than its cell
// and overflowing the viewport.
export const Root = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`;

// Pure flex spacer — fills the leftover vertical space above + below the
// centered welcome block. Disappears entirely (no DOM node) in non-empty state.
export const Spacer = styled.div`
  flex-grow: 1;
  flex-shrink: 1;
  flex-basis: 0;
  min-height: 0;
`;

// `$centered` drops the docked-mode chrome (border-top divider, full-bleed
// panel bg) so the welcome-screen composer reads as a free-floating input
// rather than a docked bar. The width clamp + auto margins keep it readable on
// wide panels while still going edge-to-edge on narrow ones.
export const Composer = styled.div<{ $centered: boolean }>`
  /* Opaque + above the messages so the chat scroll never bleeds under the
     input. The widget card no longer tucks behind it — it overlays the chat
     area above the composer (see WidgetOverlay). */
  position: relative;
  z-index: 1;
  border-top: ${({ theme, $centered }) =>
    $centered ? "none" : `1px solid ${theme.colors.border}`};
  background: ${({ theme, $centered }) =>
    $centered ? "transparent" : theme.colors.bgPanel};
  ${({ $centered }) =>
    $centered
      ? `
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
  `
      : ""}
`;
