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

import {
  SuggestionCheckbox,
  SuggestionRow,
} from "@/components/Chat/widgets/sharedStyles";
import { useChatStore } from "@/lib/chatStore";
import type {
  DiscoveryListView,
  DiscoveryRow,
} from "@/server/views/discoveryList";

import { PanelSendChangesButton } from "./shared/PanelRowCard";

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

  // SuggestionRow is a label, so the whole row is the hit target and takes the
  // accent border when checked — the same control the chat widgets use.
  return (
    <SuggestionRow>
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
    </SuggestionRow>
  );
}

export function DiscoveryView({ discovery }: { discovery: DiscoveryListView }) {
  const send = useChatStore((s) => s.send);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const streaming = useChatStore((s) => s.streaming);
  const pending = discovery.pendingMarks;
  const checked = discovery.rows.filter((r) => r.checked).length;

  return (
    <Root>
      <Header>
        {discovery.rows.length > 0 && !readOnly && (
          // Adaptive like the board's: it spares a round trip by saying the list
          // is settled AND that Hank should go ahead, so he commits instead of
          // asking "want me to add those?".
          <PanelSendChangesButton
            disabled={streaming}
            onClick={() =>
              void send(
                pending > 0
                  ? "That's the company list how I want it — go ahead and add the ones still checked."
                  : "The company list looks right as it stands — go ahead and add them.",
              )
            }
          >
            {pending > 0 ? "Send my changes" : "Looks good to me"}
          </PanelSendChangesButton>
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
