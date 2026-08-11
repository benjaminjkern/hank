"use client";

// The shortlist board — one company's round, split by what COMMITTING it does:
// the live rows on top, and a collapsed "Closing these" pile holding every role
// the commit would close (marked pass, or ruled out by the automatic filtering
// before the shortlist ever saw it).
//
// Every row carries the SAME three marks (Shortlist / Defer / Close) and exactly
// one is set, so agreeing with Hank costs no clicks and a filtered row shows
// Close already selected. Re-clicking the set mark does nothing: there is no
// no-opinion state to clear to — Defer already means "don't close it, don't
// commit to it". That's also why there's no separate "actually, consider this":
// marking a filtered row Shortlist or Defer is what un-closes it.
//
// A row the user re-marks KEEPS its position, flagged pending, until their next
// chat message relays it — rows never move out from under the cursor, and the
// order within a group never depends on when a row was written. Nothing
// structural happens until that relay either: a mark on a filtered row is a
// proposal, and the un-close waits for Hank to see it. Roles decided in an
// EARLIER round aren't here at all; the company page's never-pursued list is
// where those live. Nothing is final until Hank commits the board in chat.

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import type {
  ShortlistBoardView as ShortlistBoardData,
  ShortlistBoardRow,
  ShortlistBoardTier,
} from "@/server/views/shortlistBoard";

import { PanelRowCard, PanelSendChangesButton } from "./shared/PanelRowCard";
import {
  StanceMarks,
  STANCE_OF_VERDICT,
  type StanceValue,
} from "./shared/StanceMarks";

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
  font-size: 16px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const OpenNote = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const TierSection = styled.section`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
`;

const TierHeader = styled.button`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  background: transparent;
  cursor: pointer;
  padding: ${({ theme }) => theme.space.xs} 0;
  text-align: left;
`;

const TierCaret = styled.span<{ $open: boolean }>`
  display: inline-block;
  transition: transform 120ms ease;
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  color: ${({ theme }) => theme.colors.textSubtle};
  font-size: 10px;
`;

const TierTitle = styled.h3`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const TierCount = styled.span`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-family: ${({ theme }) => theme.font.mono};
`;

const RowTop = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const RowTitle = styled.span`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  overflow-wrap: anywhere;
`;

const RowMeta = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  overflow-wrap: anywhere;
`;

const RowReason = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-style: italic;
`;

const StanceRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  flex-wrap: wrap;
`;

// Sits at the end of the stance row: same height as the marks, text rather than
// an icon, so "open this" reads as a different kind of action from "mark this".
const ViewRoleButton = styled.button`
  margin-left: auto;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    border-color: ${({ theme }) => theme.colors.accent};
    color: ${({ theme }) => theme.colors.accent};
  }
`;

const ScanTag = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// The screen has two groups, not one per tier, and the line between them is
// what COMMITTING does: `keep` survives it, `discard` is closed by it. Rows
// arrive with their mark pre-selected, so a heading per verdict only restated
// what the marks already say.
//
// That's why "not read yet" and "on hold" sit with the live rows despite nobody
// having ranked them — they survive the commit, so filing them under a heading
// about closing would be a lie about what happens next.
type BoardGroup = "keep" | "discard";

const GROUP_OF_TIER: Record<ShortlistBoardTier, BoardGroup> = {
  picks: "keep",
  borderline: "keep",
  undecided: "keep",
  notReadYet: "keep",
  onHold: "keep",
  pass: "discard",
  filteredThisRound: "discard",
};

const DISCARD_LABEL = "Closing these";
const DISCARD_HINT =
  "Marked pass, or ruled out before the shortlist. Committing closes them — mark one Shortlist or Defer to pull it back.";

function rowMeta(row: ShortlistBoardRow): string {
  return [row.location, row.compensation, row.employmentType]
    .filter(Boolean)
    .join(" · ");
}

// What the row is marked as right now. A row placed by an earlier commit carries
// no stance, so fall back to the group it sits in.
function stanceOf(
  row: ShortlistBoardRow,
  tier: ShortlistBoardTier,
): StanceValue | null {
  if (row.verdict) return STANCE_OF_VERDICT[row.verdict] ?? null;
  if (tier === "picks") return "pick";
  if (tier === "borderline") return "borderline";
  if (tier === "pass") return "pass";
  // A row the filtering closed is already a close — showing Close selected is
  // what makes the three marks say the same thing on every card, and it's why
  // there's no separate revive button: the other two marks un-close it.
  if (tier === "filteredThisRound") return "pass";
  return null;
}

type PlacedRow = { tier: ShortlistBoardTier; row: ShortlistBoardRow };

function BoardRow({
  companyId,
  tier,
  row,
}: {
  companyId: string;
  tier: ShortlistBoardTier;
  row: ShortlistBoardRow;
}) {
  const viewJob = useChatStore((s) => s.viewJob);
  const editShortlistBoard = useChatStore((s) => s.editShortlistBoard);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const [busy, setBusy] = useState(false);

  const stance = stanceOf(row, tier);
  const filtered = tier === "filteredThisRound";

  // Every row carries exactly one of the three, so re-clicking the mark it
  // already has is a no-op rather than an un-select. Defer is the "leave it
  // alone" answer; a fourth no-opinion state made a cleared mark and an accepted
  // proposal indistinguishable to the diff.
  async function mark(next: StanceValue) {
    if (busy || next === stance) return;
    setBusy(true);
    try {
      await editShortlistBoard(companyId, row.jobId, next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelRowCard $pending={row.pending}>
      <RowTop>
        <RowTitle>{row.title}</RowTitle>
      </RowTop>
      {rowMeta(row) && <RowMeta>{rowMeta(row)}</RowMeta>}
      {row.reason && <RowReason>{row.reason}</RowReason>}
      {row.overriddenAgentVerdict && (
        <ScanTag>
          Hank had this as {row.overriddenAgentVerdict.toLowerCase()}
          {row.overriddenAgentReason ? ` — ${row.overriddenAgentReason}` : ""}
        </ScanTag>
      )}
      {row.unfinishedApplication && (
        <ScanTag>✎ You started an application here and never sent it.</ScanTag>
      )}
      {row.scanDissent && <ScanTag>⚠ {row.scanDissent}</ScanTag>}
      <StanceRow>
        {!readOnly && row.markable && (
          <StanceMarks
            stance={stance}
            onMark={(next) => void mark(next)}
            disabled={busy}
            filtered={filtered}
            label={`Your call on ${row.title}`}
          />
        )}
        {busy && <ScanTag>saving…</ScanTag>}
        <ViewRoleButton onClick={() => void viewJob(row.jobId)}>
          View role →
        </ViewRoleButton>
      </StanceRow>
    </PanelRowCard>
  );
}

function DiscardGroup({
  companyId,
  placed,
}: {
  companyId: string;
  placed: PlacedRow[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <TierSection>
      <TierHeader onClick={() => setOpen((o) => !o)}>
        <TierCaret $open={open}>▶</TierCaret>
        <TierTitle>{DISCARD_LABEL}</TierTitle>
        <TierCount>{placed.length}</TierCount>
        {open && <ScanTag>— {DISCARD_HINT}</ScanTag>}
      </TierHeader>
      {open &&
        placed.map(({ tier, row }) => (
          <BoardRow
            key={row.jobId}
            companyId={companyId}
            tier={tier}
            row={row}
          />
        ))}
    </TierSection>
  );
}

export function ShortlistBoardView({ board }: { board: ShortlistBoardData }) {
  const send = useChatStore((s) => s.send);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const streaming = useChatStore((s) => s.streaming);
  const pending = board.pendingEdits;

  // The server's tier order IS the render order within each group, so
  // flattening keeps picks ahead of borderline ahead of pass.
  const keep: PlacedRow[] = [];
  const discard: PlacedRow[] = [];
  for (const { tier, rows } of board.tiers) {
    const bucket = GROUP_OF_TIER[tier] === "keep" ? keep : discard;
    for (const row of rows) bucket.push({ tier, row });
  }

  return (
    <Root>
      <Header>
        {board.open && !readOnly && (
          <PanelSendChangesButton
            disabled={streaming}
            onClick={() =>
              void send(
                pending > 0
                  ? "These are my changes to the board — if you agree with them, go ahead and lock the shortlist in."
                  : "The board looks right to me as it stands — if you agree, go ahead and lock the shortlist in.",
              )
            }
          >
            {pending > 0 ? "Send my changes" : "Looks good to me"}
          </PanelSendChangesButton>
        )}
        <H2>{board.companyName} — shortlist</H2>
        {!board.open && (
          <OpenNote>
            This shortlist is locked in — nothing left to decide here. To change
            your mind on a role, just tell Hank in chat.
          </OpenNote>
        )}
      </Header>
      <TierSection>
        {keep.map(({ tier, row }) => (
          <BoardRow
            key={row.jobId}
            companyId={board.companyId}
            tier={tier}
            row={row}
          />
        ))}
      </TierSection>
      {discard.length > 0 && (
        <DiscardGroup companyId={board.companyId} placed={discard} />
      )}
    </Root>
  );
}
