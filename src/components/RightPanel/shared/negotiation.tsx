"use client";

// The chrome and the one rule every negotiation panel shares — the shortlist
// board, the discovery list, and one job's application. Each is the same
// object: Hank proposes, the user amends in place, and one commit settles it.
//
// THE ACCENT COLOUR MEANS EXACTLY ONE THING HERE: "you changed this and Hank
// hasn't seen it." Nothing else on a negotiation row may use it. That rule is
// the whole reason this file exists — the same border previously meant "unsent"
// on the board, "will be added" on discovery, and "unsent, plus a glow" on the
// application, so the one visual users had to learn read differently on each of
// the three screens they meet it on.

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

const Tag = styled.span`
  flex-shrink: 0;
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
export function PendingTag({ change }: { change?: string | null }) {
  return (
    <Tag>{(change && CHANGE_WORD[change]) || "changed"} · not sent yet</Tag>
  );
}

// The one control that ends a negotiation. Text rather than an icon: it's the
// button that settles the surface, so it says so.
const NegotiationButton = styled.button`
  align-self: flex-start;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  cursor: pointer;
  margin-bottom: ${({ theme }) => theme.space.xs};

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.bgHover};
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

// What pressing the panel's settle button MEANS right now. The three cases are
// genuinely different conversations, which is why one rule decides it for all
// three surfaces rather than each guessing:
//
//   changes — the user moved something. Hank has to see it: he wrote the
//             proposal they just overruled, and the relay hands him his own
//             reasoning next to theirs so he can engage with the disagreement.
//   threads — something he raised is still unanswered. He asks about it in his
//             own words; a client-side "3 things are flagged" note can't.
//   commit  — nothing diverges and nothing is outstanding, so there is nothing
//             for him to react to. Settle it and skip the turn.
//
// Only the last one is a structured choice; the other two are messages.
type NegotiationIntent = "changes" | "threads" | "commit";

function negotiationIntent(state: NegotiationState): NegotiationIntent {
  if (state.pendingCount > 0) return "changes";
  if (state.openThreadCount > 0) return "threads";
  return "commit";
}

// The adaptive settle pill. Every panel renders this one component, and supplies
// only the words — the labels differ because the surfaces do ("looks good to me"
// settles a proposal; "I submitted ✓" records something that already happened),
// while the decision behind them must not.
export function NegotiationSettleButton({
  state,
  disabled,
  labels,
  onSend,
  onCommit,
}: {
  state: NegotiationState;
  disabled?: boolean;
  labels: Record<NegotiationIntent, string>;
  // Free text for the two cases Hank has to answer.
  onSend: (intent: "changes" | "threads") => void;
  // The structured choice — settles the panel with no agent turn.
  onCommit: () => void;
}) {
  const intent = negotiationIntent(state);
  return (
    <NegotiationButton
      disabled={disabled}
      onClick={() => (intent === "commit" ? onCommit() : onSend(intent))}
    >
      {labels[intent]}
    </NegotiationButton>
  );
}
