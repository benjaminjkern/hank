"use client";

// Companies the search has proposed and the user hasn't settled. Two marks per
// row — Add and Pass — with UNMARKED as the default and a real third state:
// an unmarked candidate stays on the table and rides into the next search, so
// nothing here forces a verdict. Clicking the active mark clears it.
//
// A mark decides nothing on its own. It persists immediately, rides the user's
// next chat message as a panel edit, and Hank's commit_discovery is what
// actually adds or records anything — which is why marking is free and why the
// user can talk about the list ("these are all too big") instead of only
// clicking at it.

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import type {
  DiscoveryListView,
  DiscoveryRow,
  DiscoverySettledRow,
} from "@/server/views/discoveryList";

import { PanelRowCard, PanelSendChangesButton } from "./shared/PanelRowCard";
import { useExpandable } from "./shared/useExpandable";

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

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const SectionLabel = styled.button`
  align-self: flex-start;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;

  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const RowTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const Name = styled.span`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  overflow-wrap: anywhere;
`;

const Reason = styled.div`
  font-size: 12px;
  line-height: 1.45;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Marks = styled.div`
  display: flex;
  gap: 4px;
  flex-shrink: 0;
`;

const MarkButton = styled.button<{ $active?: boolean }>`
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid
    ${({ theme, $active }) =>
      $active ? theme.colors.accent : theme.colors.border};
  color: ${({ theme, $active }) =>
    $active ? theme.colors.accent : theme.colors.textMuted};
  background: ${({ theme, $active }) =>
    $active ? theme.colors.bgMuted : "transparent"};
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: ${({ theme }) => theme.colors.accent};
    color: ${({ theme }) => theme.colors.accent};
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const SettledRow = styled.div`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  font-size: 12px;
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

  // Clicking the mark a row already carries clears it — the un-select, which
  // lands the row back on the table rather than forcing a choice.
  async function mark(next: "add" | "pass") {
    if (busy) return;
    setBusy(true);
    try {
      await markSuggestion(row.id, next === row.mark ? "unmarked" : next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelRowCard>
      <RowTop>
        <Name>{row.name}</Name>
        {!readOnly && (
          <Marks>
            <MarkButton
              $active={row.mark === "add"}
              disabled={busy}
              onClick={() => void mark("add")}
            >
              Add
            </MarkButton>
            <MarkButton
              $active={row.mark === "pass"}
              disabled={busy}
              onClick={() => void mark("pass")}
            >
              Pass
            </MarkButton>
          </Marks>
        )}
      </RowTop>
      <Reason>{row.reason}</Reason>
    </PanelRowCard>
  );
}

function SettledSection({
  label,
  rows,
  glyph,
}: {
  label: string;
  rows: DiscoverySettledRow[];
  glyph: string;
}) {
  // previewCount 0 = collapsed shows nothing; the label carries the count, so
  // the tail is a heading you open rather than a "+N more" tease.
  const { visible, expanded, toggle } = useExpandable(rows, 0);
  if (rows.length === 0) return null;
  return (
    <Section>
      <SectionLabel onClick={toggle}>
        {expanded ? "▾" : "▸"} {label} ({rows.length})
      </SectionLabel>
      {visible.map((r) => (
        <SettledRow key={r.id}>
          <span>{glyph}</span>
          <span>{r.name}</span>
        </SettledRow>
      ))}
    </Section>
  );
}

export function DiscoveryView({ discovery }: { discovery: DiscoveryListView }) {
  const send = useChatStore((s) => s.send);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const streaming = useChatStore((s) => s.streaming);
  const pending = discovery.pendingMarks;

  return (
    <Root>
      <Header>
        {discovery.open.length > 0 && !readOnly && (
          // Spares a round trip the way the board's does: it says the marks are
          // what they want AND that Hank should act on them, so he commits
          // instead of asking "shall I add those?".
          <PanelSendChangesButton
            disabled={streaming || pending === 0}
            onClick={() =>
              void send(
                "That's how I want the company list marked — go ahead and add the ones I marked to add.",
              )
            }
          >
            {pending > 0
              ? `Send ${pending} change${pending === 1 ? "" : "s"}`
              : "Nothing marked yet"}
          </PanelSendChangesButton>
        )}
        <H2>Companies to consider</H2>
      </Header>

      {discovery.open.length === 0 ? (
        <Empty>
          Nothing waiting on you here. Ask for more companies in chat whenever
          you want another look.
        </Empty>
      ) : (
        <Section>
          {discovery.open.map((row) => (
            <CandidateRow key={row.id} row={row} />
          ))}
        </Section>
      )}

      <SettledSection label="added" rows={discovery.added} glyph="✓" />
      <SettledSection label="passed" rows={discovery.passed} glyph="✕" />
    </Root>
  );
}
