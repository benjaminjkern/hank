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
import { buildWidgetSubmissionMessage } from "@/components/Chat/widgets/types";
import { useChatStore } from "@/lib/chatStore";
import type {
  DiscoveryListView,
  DiscoveryRow,
} from "@/server/views/discoveryList";

import {
  NegotiationSettleButton,
  PanelRowCard,
  PendingTag,
} from "./shared/negotiation";

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

const Row = styled(PanelRowCard)<{ $dropped: boolean }>`
  flex-direction: row;
  align-items: flex-start;
  gap: ${({ theme }) => theme.space.sm};
  cursor: pointer;

  /* Unchecked means "not going in" — the row stays readable and stops competing
     for attention with the ones that are. */
  opacity: ${({ $dropped }) => ($dropped ? 0.55 : 1)};
  transition: opacity 0.12s ease;
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
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
  // Checked is the DEFAULT here — every company arrives proposed — so it draws
  // as an ordinary card and the unchecked ones dim instead. That's the right way
  // round for a list whose whole job is unchecking, and it leaves the accent
  // border free to mean what it means on every other negotiation panel: you
  // changed this and Hank hasn't seen it.
  return (
    <Row as="label" $pending={row.pending} $dropped={!row.checked}>
      <SuggestionCheckbox
        type="checkbox"
        checked={row.checked}
        disabled={busy || readOnly}
        onChange={() => void toggle()}
      />
      <Body>
        <Name>{row.name}</Name>
        <Reason>{row.reason}</Reason>
      </Body>
      {row.pending && <PendingTag />}
    </Row>
  );
}

export function DiscoveryView({ discovery }: { discovery: DiscoveryListView }) {
  const send = useChatStore((s) => s.send);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const streaming = useChatStore((s) => s.streaming);
  const checked = discovery.rows.filter((r) => r.checked).length;

  return (
    <Root>
      <Header>
        {discovery.rows.length > 0 && !readOnly && (
          // Untouched list, nothing outstanding: adding it is what Hank proposed
          // by finding these, so the press settles it directly instead of buying
          // a turn in which he agrees with himself.
          <NegotiationSettleButton
            state={discovery}
            disabled={streaming}
            labels={{
              changes: "Send my changes",
              threads: "Send my changes",
              commit: "Looks good to me",
            }}
            onSend={() =>
              void send(
                "That's the company list how I want it — go ahead and add the ones still checked.",
              )
            }
            onCommit={() =>
              void send(
                buildWidgetSubmissionMessage(
                  { kind: "commit_negotiation", panel: "discovery" },
                  "[The company list looks right — add them]",
                ),
              )
            }
          />
        )}
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
