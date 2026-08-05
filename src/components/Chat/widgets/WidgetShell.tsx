"use client";

// Shared chrome for every pipeline widget. One source of truth for:
//   - the floating-card styling (rounded, side-inset, drop-shadow). The card
//     is mounted by ChatPanel inside an absolutely-positioned overlay that
//     sits *above* the chat scroll area (it no longer steals layout height —
//     the scroll region reserves bottom padding so messages clear it). The
//     overlay caps height at ~70% of the chat area; this card fills up to that
//     cap via the flex chain below.
//   - the three-region layout: a sticky Header and sticky Footer that stay
//     pinned + always visible, with only the Body scrolling between them.
//   - the minimize (−/+) control. On by default for EVERY widget (the small
//     confirmations included — a long close-reason or submit prompt should be
//     collapsible just like the content-heavy ones). A widget can still opt out
//     with `minimizable={false}` if collapsing it would never make sense.
//
// New widgets should render their scrollable content as `children` and pass
// their action area (buttons / note + submit) as `footer`. See docs/ui.md →
// "Composer + sticky widget slot".

import { useState, type ReactNode } from "react";
import styled from "styled-components";

type Props = {
  title: ReactNode;
  // Right-aligned header content (e.g. shortlist's "3/5 selected" meta).
  headerExtra?: ReactNode;
  // Pinned footer — the widget's action area (button row, or shortlist's
  // note + Approve). Always visible; never scrolls with the body.
  footer?: ReactNode;
  // Renders the −/+ toggle and supports collapsing to a one-line bar. On by
  // default for every widget; pass `false` only to opt a widget out.
  minimizable?: boolean;
  // Compact label shown when collapsed; falls back to `title`.
  minimizedSummary?: ReactNode;
  // Disables the minimize toggle (e.g. mid-submit).
  disabled?: boolean;
  // Scrollable body content.
  children: ReactNode;
};

export function WidgetShell({
  title,
  headerExtra,
  footer,
  minimizable = true,
  minimizedSummary,
  disabled = false,
  children,
}: Props) {
  const [minimized, setMinimized] = useState(false);

  if (minimizable && minimized) {
    return (
      <MinimizedCard>
        <MinimizedLabel>{minimizedSummary ?? title}</MinimizedLabel>
        <IconButton
          type="button"
          onClick={() => setMinimized(false)}
          aria-label="Expand"
          title="Expand"
        >
          +
        </IconButton>
      </MinimizedCard>
    );
  }

  return (
    <Card>
      <HeaderRow>
        <Title>{title}</Title>
        {(headerExtra || minimizable) && (
          <HeaderRight>
            {headerExtra}
            {minimizable && (
              <IconButton
                type="button"
                onClick={() => setMinimized(true)}
                disabled={disabled}
                aria-label="Minimize"
                title="Minimize"
              >
                −
              </IconButton>
            )}
          </HeaderRight>
        )}
      </HeaderRow>
      <Body>{children}</Body>
      {footer != null && <Footer>{footer}</Footer>}
    </Card>
  );
}

// Floating-card chrome. ChatPanel's WidgetOverlay caps the height (~70% of the
// chat area) and re-enables pointer events (the overlay itself is
// pointer-events:none so chat shows through the side gutters). `flex: 1` lets
// the card fill the capped overlay so the Body scrolls; `overflow: hidden`
// clips the scrolling Body to the rounded corners.
const Card = styled.div`
  pointer-events: auto;
  flex: 1 1 auto;
  min-height: 0;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.16);
  overflow: hidden;
`;

// One-line collapsed bar. Equal margins around the +/- button on top / right /
// bottom (left differs — that's the label side).
const MinimizedCard = styled.div`
  pointer-events: auto;
  flex: 0 0 auto;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.16);
`;

const MinimizedLabel = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
`;

// Pinned — never scrolls.
const HeaderRow = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
`;

// The only scrolling region. `overscroll-behavior: contain` keeps a trackpad
// over-scroll from chaining to the chat scroll behind it (which would flash a
// different background).
const Body = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 16px 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

// Pinned — always visible.
const Footer = styled.div`
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px 14px;
`;

const Title = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const HeaderRight = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const IconButton = styled.button`
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 6px;
  font-size: 16px;
  line-height: 1;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  &:not(:disabled):hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;
