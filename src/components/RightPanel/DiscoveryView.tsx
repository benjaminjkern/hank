"use client";

// The companies the last search proposed. Every row arrives CHECKED — surfacing
// a company is the proposal that it's worth tracking — so agreeing costs no
// clicks and the user's job is to uncheck what they don't want and send.
//
// A checkbox decides nothing on its own. It persists immediately, rides the
// user's next chat message as a panel edit, and Hank's commit_discovery adds
// everything still checked and records the rest — which is why clicking is free,
// and why the user can talk about the list ("these are all too big") instead of
// only clicking at it.

import { useState } from "react";
import styled from "styled-components";

import { SuggestionCheckbox } from "@/components/Chat/widgets/sharedStyles";
import { useChatStore } from "@/lib/chatStore";
import type {
  DiscoveryListView,
  DiscoveryRow,
} from "@/server/views/discoveryList";

import { PanelRowCard } from "./shared/negotiation";

const Root = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.lg};
`;

const Header = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
  align-items: flex-start;
`;

const H2 = styled.h2`
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const Sub = styled.p`
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const Row = styled(PanelRowCard)`
  flex-direction: row;
  align-items: flex-start;
  gap: ${({ theme }) => theme.space.sm};
  cursor: pointer;
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Owns the free space, so the pending tag sits at a fixed right edge instead
     of shifting the name and reason when it appears. */
  flex: 1;
  min-width: 0;
`;

const Name = styled.span`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  overflow-wrap: anywhere;
`;

const Reason = styled.span`
  font-size: 12px;
  line-height: 1.45;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Empty = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

function CandidateRow({ row }: { row: DiscoveryRow }) {
  const markSuggestion = useChatStore((s) => s.markSuggestion);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      await markSuggestion(row.id, row.checked ? "pass" : "add");
    } finally {
      setBusy(false);
    }
  }

  // The whole row is the hit target (the card is a label), and the checkbox is
  // the same themed control the chat widgets use.
  //
  // The checkbox is the ONLY thing that says checked or unchecked — no dimming,
  // no strikethrough. Every company arrives checked, so unchecking is the common
  // gesture, and any second treatment for it lands on the same rows as the
  // pending border and reads as part of it.
  return (
    <Row as="label" $pending={row.pending}>
      <SuggestionCheckbox
        type="checkbox"
        checked={row.checked}
        disabled={busy || readOnly}
        onChange={() => void toggle()}
      />
      {/* The search's own notes on the company, as a native tooltip: the row is
          a <label>, so an inline expander would fight the click target that
          toggles the checkbox. Hank answers from the same text in chat. */}
      <Body title={row.summary ?? undefined}>
        <Name>{row.name}</Name>
        <Reason>{row.reason}</Reason>
      </Body>
    </Row>
  );
}

export function DiscoveryView({ discovery }: { discovery: DiscoveryListView }) {
  const checked = discovery.rows.filter((r) => r.checked).length;

  return (
    <Root>
      <Header>
        <H2>Companies to add</H2>
        {discovery.rows.length > 0 && (
          <Sub>
            {checked === discovery.rows.length
              ? `All ${discovery.rows.length} are set to add — uncheck any you don't want, then send.`
              : `Adding ${checked} of ${discovery.rows.length} — send when it looks right.`}
          </Sub>
        )}
      </Header>

      {discovery.rows.length === 0 ? (
        <Empty>
          Nothing waiting on you here. Ask for companies in chat whenever you
          want a fresh look.
        </Empty>
      ) : (
        <List>
          {discovery.rows.map((row) => (
            <CandidateRow key={row.id} row={row} />
          ))}
        </List>
      )}
    </Root>
  );
}
