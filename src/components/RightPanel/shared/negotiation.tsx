"use client";

// The chrome and the one rule every negotiation panel shares — the shortlist
// board, the discovery list, and one job's application. Each is the same
// object: Hank proposes, the user amends in place, and one commit settles it.
//
// THE ACCENT COLOUR MEANS EXACTLY ONE THING HERE: "you changed this and Hank
// hasn't seen it." Nothing else on a negotiation row may use it, and the border
// is the WHOLE treatment — no glow, no fill, no dimming. One visual, learned
// once, identical on all three screens.
//
// A row also may not CHANGE SIZE when it becomes pending, which is why the tag
// is always in the layout and only toggles visibility. Rendering it
// conditionally reflows the row that was just clicked — the text re-wraps, the
// height changes, and every row below it jumps.

import styled from "styled-components";

import type { NegotiationState } from "@/server/views/negotiationPanel";

// The bordered row card the negotiation panels draw.
//
// Deliberately NOT hover-lit and not a click target: the marks are their own
// buttons and opening a row is its own explicit button, so a card that lights up
// under the cursor promises a click that isn't there.
export const PanelRowCard = styled.div<{ $pending?: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  border: 1px solid
    ${({ theme, $pending }) =>
      $pending ? theme.colors.accent : theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  min-width: 0;
`;

// What the pending change DID, said in the user's terms. The vocabulary is the
// relay's (`ApplicationEdit["change"]`), so the tag on screen and the line Hank
// reads describe the same event — "written" for text typed from scratch rather
// than calling it an edit, which is what the page used to say for everything.
const CHANGE_WORD: Record<string, string> = {
  wrote: "written",
  revised: "edited",
  cleared: "cleared",
  added: "added",
};

const Tag = styled.span<{ $shown: boolean }>`
  flex-shrink: 0;
  /* Always in the layout, so a click can't resize the row it landed on. */
  visibility: ${({ $shown }) => ($shown ? "visible" : "hidden")};
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  white-space: nowrap;
  color: ${({ theme }) => theme.colors.accent};
`;

// The "· not sent yet" half is the load-bearing part: it says the change is
// real and saved, and that Hank still doesn't know. Pass `change` where the
// surface tracks what kind of change it was; a surface whose rows only ever
// move between marks (the board, discovery) says "changed".
//
// Render it on EVERY row, pending or not — it reserves its own space, so the
// row's size is the same either way (see the header).
export function PendingTag({
  pending,
  change,
}: {
  pending: boolean;
  change?: string | null;
}) {
  return (
    <Tag $shown={pending} aria-hidden={!pending}>
      {(change && CHANGE_WORD[change]) || "changed"} · not sent yet
    </Tag>
  );
}

// The one control that ends a negotiation. Text rather than an icon: it's the
// button that settles the surface, so it says so.
export const NegotiationButton = styled.button`
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.bgHover};
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

// The sticky footer that settles a negotiation, and the rule for when it exists
// at all: ONLY when there is nothing to send.
//
// That split is what keeps one action per state. While the user has unsent
// changes, the send path is the composer chip — it already counts them, it can
// be cancelled, and it puts the message where every other message goes. A second
// control on the panel doing the same thing would be a second way to do one
// thing, and the two would drift.
//
// So the bar means what it says: everything on this screen is agreed, and this
// button ends it. It sits at the bottom because that is where you are once
// you've read down the list, and it sticks so a long board doesn't hide it.
const Bar = styled.div`
  position: sticky;
  /* Flush to the panel's bottom edge: sticking to bottom 0 lands on the
     scrollport's content box, so the negative margins carry the bar out over
     the panel's own padding. */
  bottom: 0;
  margin: 0 calc(-1 * ${({ theme }) => theme.space.xl})
    calc(-1 * ${({ theme }) => theme.space.xl});
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.xl};
  display: flex;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space.sm};
  background: ${({ theme }) => theme.colors.bg};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
`;

export function NegotiationBar({
  state,
  children,
}: {
  state: NegotiationState;
  children: React.ReactNode;
}) {
  // Settled panels have nothing to settle, and a panel with unsent changes is
  // the composer chip's business.
  if (!state.open || state.pendingCount > 0) return null;
  return <Bar>{children}</Bar>;
}
