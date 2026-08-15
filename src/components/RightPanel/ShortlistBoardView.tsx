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
import {
  BOARD_GROUP_OF_TIER,
  type ShortlistBoardTier,
} from "@/lib/shortlistBoardTiers";
// Types only — the loader beside them opens a database connection, so a VALUE
// from that module would follow Prisma into the browser bundle.
import type {
  ShortlistBoardView as ShortlistBoardData,
  ShortlistBoardRow,
} from "@/server/views/shortlistBoard";

import { PanelRowCard } from "./shared/negotiation";
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

// The empty-round state — shown only when the keep side is LITERALLY empty
// (every row on the board is in the closing pile), so nothing sits above the
// fold. A full-width centered block: big icon, one sentence under it. Same
// 1.5px stroke-on-currentColor language as the stance marks rather than a
// picture.
const EmptyRound = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.space.md};
  width: 100%;
  padding: ${({ theme }) => theme.space.xl} ${({ theme }) => theme.space.lg};
  color: ${({ theme }) => theme.colors.textMuted};
`;

const EmptyRoundMark = styled.span`
  display: inline-flex;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const EmptyRoundText = styled.span`
  font-size: 13px;
  text-align: center;
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

const DISCARD_LABEL = "Closing these";
const DISCARD_HINT =
  "Everything Hank passed on, whichever pass ruled it out — strongest first. Nothing here is closed yet; committing is what closes them, so mark one Shortlist or Defer to pull it back.";

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
  // A commit is mid-flight: the marks freeze, because a mark made now would be
  // silently raced by the commit's stance clear. The store's edit action
  // refuses too; this is the visible half.
  const settling = useChatStore((s) => s.boardSettling);
  const [busy, setBusy] = useState(false);

  const stance = stanceOf(row, tier);

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
      <StanceRow>
        {!readOnly && row.markable && (
          <StanceMarks
            stance={stance}
            onMark={(next) => void mark(next)}
            disabled={busy || settling}
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
  // The server's tier order IS the render order within each group, so
  // flattening keeps picks ahead of borderline ahead of pass.
  const keep: PlacedRow[] = [];
  const discard: PlacedRow[] = [];
  for (const { tier, rows } of board.tiers) {
    const bucket = BOARD_GROUP_OF_TIER[tier] === "keep" ? keep : discard;
    for (const row of rows) bucket.push({ tier, row });
  }

  // Only when NOTHING sits above the fold — every row on the board is in the
  // closing pile. A board that still shows holds or undecided rows explains
  // itself; the graphic exists for the round where the live area would
  // otherwise just be blank. Short on purpose: Hank explains what happened in
  // the chat beside this, and a second copy of that reasoning on the panel is
  // the same paragraph twice, in the surface with less room for it.
  const emptyRound = keep.length === 0 && discard.length > 0;

  return (
    <Root>
      <Header>
        <H2>{board.companyName} — shortlist</H2>
        {!board.open && (
          <OpenNote>
            This shortlist is locked in — nothing left to decide here. To change
            your mind on a role, just tell Hank in chat.
          </OpenNote>
        )}
      </Header>
      {board.open && emptyRound && (
        <EmptyRound>
          <EmptyRoundMark aria-hidden>
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4.2-4.2" />
              <path d="M8.5 11h5" />
            </svg>
          </EmptyRoundMark>
          <EmptyRoundText>Nothing to shortlist this round.</EmptyRoundText>
        </EmptyRound>
      )}
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
