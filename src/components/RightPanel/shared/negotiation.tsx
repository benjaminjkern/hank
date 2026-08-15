"use client";

// The chrome and the one rule every negotiation panel shares — the shortlist
// board, the discovery list, and one job's application. Each is the same
// object: Hank proposes, the user amends in place, and one commit settles it.
//
// THE ACCENT BORDER MEANS EXACTLY ONE THING: "you changed this and Hank hasn't
// seen it." Nothing else on a negotiation row may use that colour, and the
// border is the WHOLE treatment — no glow, no fill, no dimming, and no tag
// spelling it out. One visual, learned once, identical on all three screens.
//
// There is deliberately no per-row "not sent yet" label. The border says WHICH
// rows changed; the composer chip says what to do about them, once, for the
// whole batch. A caption on every row repeats in N places what the border
// already showed, and it cost real UX: rendering it only when pending resized
// the row that was just clicked, so the list jumped under the cursor.

import { useState } from "react";
import styled from "styled-components";

import { buildWidgetSubmissionMessage } from "@/components/Chat/widgets/types";
import { useChatStore } from "@/lib/chatStore";
import { BOARD_GROUP_OF_TIER } from "@/lib/shortlistBoardTiers";
import type { NegotiationState } from "@/server/views/negotiationPanel";
// Type only — the loader beside it opens a database connection, so a VALUE
// from that module would follow Prisma into the browser bundle.
import type { ShortlistBoardView } from "@/server/views/shortlistBoard";

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

// The panel's settle footer — a real layout row of the right panel (RightPanel's
// grid), not a sticky element inside the scroll area. Sticky fought the panel's
// own bottom padding: it stuck to the scrollport's content box, so the bar
// floated above the true bottom with a strip of panel showing under it.
//
// It exists ONLY when there is nothing to send, and that split is what keeps one
// action per state. While the user has unsent changes the send path is the
// composer chip — it already counts them, it can be cancelled, and it puts the
// message where every other message goes. A second control on the panel doing
// the same job would be a second way to do one thing, and the two would drift.
// So the bar means what it says: everything on this screen is agreed, and this
// button ends it.
const Footer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => theme.space.md} ${({ theme }) => theme.space.xl};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
`;

// One sentence above the settle button, for the single consequence the screen
// itself can't show (closing an application the user already started).
const FooterNote = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: center;
  max-width: 420px;
`;

// Filled rather than outlined, and wider than the panel's inline controls: it's
// the one action that ends the screen, so it should read as the thing to press
// rather than as one more pill among the row controls.
const SettleButton = styled.button`
  min-width: 220px;
  font-size: 14px;
  font-weight: 600;
  padding: 10px 24px;
  border-radius: 999px;
  border: 1px solid ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.onAccent};
  background: ${({ theme }) => theme.colors.accent};
  cursor: pointer;
  transition: background 0.12s ease;

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.accentHover};
    border-color: ${({ theme }) => theme.colors.accentHover};
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

// Which panel is on screen decides what settling it MEANS, so all three live
// here rather than one per view — the rule for when the footer appears is the
// same for all of them, and split across three files it would drift.
export function NegotiationFooter() {
  const panelMode = useChatStore((s) => s.panelMode);
  const board = useChatStore((s) => s.viewedBoard);
  const discovery = useChatStore((s) => s.viewedDiscovery);
  const application = useChatStore((s) => s.viewedApplication);
  const streaming = useChatStore((s) => s.streaming);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const send = useChatStore((s) => s.send);
  // Submitting with something still open takes two taps, and the first ASKS
  // HANK — what's outstanding is a question about this person that only they
  // can settle, and he can put it in words a count can't. Local because it's a
  // transient gesture; it evaporates on its own once nothing is open.
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);

  if (readOnly) return null;

  if (panelMode === "shortlist-board" && settled(board)) {
    return <ShortlistSettleFooter board={board} />;
  }

  if (panelMode === "discovery" && settled(discovery)) {
    return (
      <Footer>
        <SettleButton
          disabled={streaming}
          onClick={() =>
            void send(
              buildWidgetSubmissionMessage(
                { kind: "commit_negotiation", panel: "discovery" },
                "[The company list looks right — add them]",
              ),
            )
          }
        >
          Looks good to me
        </SettleButton>
      </Footer>
    );
  }

  // The application settles by having been SENT, not by being agreed with, so
  // its button records a fact and there is no "looks good to me" beside it.
  if (panelMode === "application" && settled(application)) {
    const open = application.openThreadCount;
    const asking = confirmingSubmit && open > 0;
    return (
      <Footer>
        <SettleButton
          disabled={streaming}
          onClick={() => {
            if (open > 0 && !confirmingSubmit) {
              setConfirmingSubmit(true);
              void send(
                "I'm ready to mark this one submitted — is there anything still open on it I should deal with first?",
              );
              return;
            }
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
            );
          }}
        >
          {asking ? "Yes, mark it submitted" : "I submitted ✓"}
        </SettleButton>
      </Footer>
    );
  }

  return null;
}

// The shortlist board's settle control — the one place the commit's consequence
// is spelled out before it happens. The label branches on what the commit will
// DO: with picks it's a plain agreement; with only holds it says they're kept;
// with nothing kept it says the company gets marked caught up. And when locking
// in would close an application the user already started, the first press asks
// — naming the roles — and only the second sends, carrying `confirmed` so the
// deterministic commit may pass the same gate Hank's confirmed re-call does.
function ShortlistSettleFooter({ board }: { board: ShortlistBoardView }) {
  const streaming = useChatStore((s) => s.streaming);
  const boardSettling = useChatStore((s) => s.boardSettling);
  const setBoardSettling = useChatStore((s) => s.setBoardSettling);
  const send = useChatStore((s) => s.send);
  const [confirmingClose, setConfirmingClose] = useState(false);

  // The footer only renders with no pending marks, so a row's TIER is its live
  // stance — counting tiers is counting the decision.
  let picks = 0;
  let kept = 0;
  const closingStarted: string[] = [];
  for (const { tier, rows } of board.tiers) {
    if (BOARD_GROUP_OF_TIER[tier] === "keep") {
      kept += rows.length;
      if (tier === "picks") picks += rows.length;
      continue;
    }
    for (const row of rows) {
      if (row.status === "APPLYING") closingStarted.push(row.title);
    }
  }

  const asking = confirmingClose && closingStarted.length > 0;
  const label = boardSettling
    ? "Settling…"
    : asking
      ? closingStarted.length === 1
        ? "Yes — close it and lock in"
        : "Yes — close them and lock in"
      : picks > 0
        ? "Looks good to me"
        : kept > 0
          ? `Lock it in — keep ${kept} for later`
          : `Close these out — mark ${board.companyName} caught up`;

  return (
    <Footer>
      {asking && !boardSettling && (
        <FooterNote>
          {closingStarted.length === 1
            ? `Locking in closes “${closingStarted[0]}” — an application you started.`
            : `Locking in closes ${closingStarted.length} roles you'd started applying to.`}
        </FooterNote>
      )}
      <SettleButton
        disabled={streaming || boardSettling}
        onClick={() => {
          if (closingStarted.length > 0 && !confirmingClose) {
            setConfirmingClose(true);
            return;
          }
          setBoardSettling(true);
          void send(
            buildWidgetSubmissionMessage(
              {
                kind: "commit_negotiation",
                panel: "shortlist-board",
                companyId: board.companyId,
                ...(closingStarted.length > 0
                  ? { confirmed: true as const }
                  : {}),
              },
              "[The board looks right — lock it in]",
            ),
          );
        }}
      >
        {label}
      </SettleButton>
    </Footer>
  );
}

// Narrows away the null payload as well as answering the question, so each
// branch above can read its panel's fields.
function settled<T extends NegotiationState>(state: T | null): state is T {
  return state !== null && state.open && state.pendingCount === 0;
}
