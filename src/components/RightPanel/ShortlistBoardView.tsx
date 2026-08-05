"use client";

// The shortlist board — every role STILL being considered at one company,
// grouped, with the deciding pass's one-line reason per row. Closed, delisted
// and applied-to roles are not here: they're decided, the user watched them go,
// and the company page's never-pursued list is where they live. Every row still open to a decision
// carries the same three marks (Pick / Maybe / Pass), pre-selected to what Hank
// proposed, so agreeing costs no clicks; clicking the current mark clears it to
// undecided. A row the user re-marks STAYS in its group, flagged pending, until
// their next chat message relays it — rows never move out from under the
// cursor. Nothing is final until Hank commits the board in chat.

import { useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import type {
  ShortlistBoardView as ShortlistBoardData,
  ShortlistBoardRow,
  ShortlistBoardTier,
} from "@/server/views/shortlistBoard";

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

// The "I'm done here" handoff. Sends a plain user message — the marks ride
// along like any other panel edit — whose whole job is to spare a round trip:
// it says the board is settled AND that Hank should go ahead if he agrees, so
// he can commit instead of asking "want me to lock it in?".
const SendChangesButton = styled.button`
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

const RowCard = styled.div<{ $pending?: boolean }>`
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

const RowTop = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const RowTitle = styled.button`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  background: transparent;
  text-align: left;
  cursor: pointer;
  min-width: 0;
  overflow-wrap: anywhere;

  &:hover {
    text-decoration: underline;
  }
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

const StanceButton = styled.button<{ $active?: boolean }>`
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid
    ${({ theme, $active }) =>
      $active ? theme.colors.accent : theme.colors.border};
  color: ${({ theme, $active }) =>
    $active ? theme.colors.accent : theme.colors.textMuted};
  background: transparent;
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

const ScanTag = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// Tier chrome: label, one-line hint, and whether the section starts open. The
// decision groups lead; the two tails (unread, on hold) start collapsed since
// neither is part of the round being settled.
const TIER_META: Record<
  ShortlistBoardTier,
  { label: string; hint?: string; defaultOpen: boolean }
> = {
  picks: { label: "Picks", hint: "Apply to these", defaultOpen: true },
  borderline: {
    label: "Borderline",
    hint: "In play — your call",
    defaultOpen: true,
  },
  pass: {
    label: "Recommended pass",
    hint: "Closed when the shortlist is locked in",
    defaultOpen: true,
  },
  undecided: { label: "Undecided", defaultOpen: true },
  notReadYet: {
    label: "Not read yet",
    hint: "Mark one and I'll read it",
    defaultOpen: false,
  },
  onHold: {
    label: "On hold",
    hint: "Parked for a reason of their own",
    defaultOpen: false,
  },
  filteredThisRound: {
    label: "Filtered out this round",
    hint: "Ruled out before the shortlist — check if something's wrong",
    defaultOpen: false,
  },
};

// The three marks, in board order. Every row that can still be decided offers
// all three — there is no separate "reconsider" affordance, and the one already
// set is pre-selected, so agreeing with Hank is doing nothing at all.
const STANCES = [
  { value: "pick", label: "Pick" },
  { value: "borderline", label: "Maybe" },
  { value: "pass", label: "Pass" },
] as const;

type StanceValue = (typeof STANCES)[number]["value"];

const STANCE_OF_VERDICT: Record<string, StanceValue> = {
  PICK: "pick",
  BORDERLINE: "borderline",
  PASS: "pass",
};

function rowMeta(row: ShortlistBoardRow): string {
  return [row.location, row.compensation, row.employmentType]
    .filter(Boolean)
    .join(" · ");
}

// What the row is marked as right now. A row placed by an earlier commit
// carries no stance, so fall back to the group it sits in.
function stanceOf(
  row: ShortlistBoardRow,
  tier: ShortlistBoardTier,
): StanceValue | null {
  if (row.verdict) return STANCE_OF_VERDICT[row.verdict] ?? null;
  if (row.pending) return null; // cleared to undecided, not yet settled
  if (tier === "picks") return "pick";
  if (tier === "borderline") return "borderline";
  if (tier === "pass") return "pass";
  return null;
}

function TierRows({
  board,
  tier,
  rows,
}: {
  board: ShortlistBoardData;
  tier: ShortlistBoardTier;
  rows: ShortlistBoardRow[];
}) {
  const meta = TIER_META[tier];
  const [open, setOpen] = useState(meta.defaultOpen);
  const viewJob = useChatStore((s) => s.viewJob);
  const editShortlistBoard = useChatStore((s) => s.editShortlistBoard);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  // Clicking the mark a row already carries clears it — that's the un-select,
  // and it lands the row in Undecided rather than forcing a choice.
  async function mark(
    row: ShortlistBoardRow,
    stance: StanceValue,
    current: StanceValue | null,
  ) {
    if (busyJobId) return;
    setBusyJobId(row.jobId);
    try {
      await editShortlistBoard(
        board.companyId,
        row.jobId,
        stance === current ? "undecided" : stance,
      );
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <TierSection>
      <TierHeader onClick={() => setOpen((o) => !o)}>
        <TierCaret $open={open}>▶</TierCaret>
        <TierTitle>{meta.label}</TierTitle>
        <TierCount>{rows.length}</TierCount>
        {meta.hint && open && <ScanTag>— {meta.hint}</ScanTag>}
      </TierHeader>
      {open &&
        rows.map((row) => {
          const stance = stanceOf(row, tier);
          const busy = busyJobId === row.jobId;
          return (
            <RowCard key={row.jobId} $pending={row.pending}>
              <RowTop>
                <RowTitle onClick={() => void viewJob(row.jobId)}>
                  {row.title}
                </RowTitle>
              </RowTop>
              {rowMeta(row) && <RowMeta>{rowMeta(row)}</RowMeta>}
              {row.reason && <RowReason>{row.reason}</RowReason>}
              {row.matchBucket && row.stanceable && (
                <ScanTag>
                  First read: {row.matchBucket.toLowerCase()}
                  {row.matchReason ? ` — ${row.matchReason}` : ""}
                </ScanTag>
              )}
              {!readOnly && row.stanceable && (
                <StanceRow>
                  {STANCES.map((s) => (
                    <StanceButton
                      key={s.value}
                      $active={stance === s.value}
                      disabled={busy}
                      title={
                        stance === s.value
                          ? "Click again to leave it undecided"
                          : undefined
                      }
                      onClick={() => void mark(row, s.value, stance)}
                    >
                      {s.label}
                    </StanceButton>
                  ))}
                  {busy && <ScanTag>saving…</ScanTag>}
                </StanceRow>
              )}
            </RowCard>
          );
        })}
    </TierSection>
  );
}

export function ShortlistBoardView({ board }: { board: ShortlistBoardData }) {
  const send = useChatStore((s) => s.send);
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const streaming = useChatStore((s) => s.streaming);
  const pending = board.pendingEdits;

  return (
    <Root>
      <Header>
        {board.open && !readOnly && (
          <SendChangesButton
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
          </SendChangesButton>
        )}
        <H2>{board.companyName} — shortlist</H2>
        <OpenNote>
          {board.open
            ? "Everything is already marked the way Hank sees it — change what you disagree with. Rows you change stay put until your next message, which is when Hank hears about them; hit send on an empty box if that's all you wanted to say. Nothing is final until you two lock it in."
            : "This shortlist is locked in — nothing left to decide here. To change your mind on a role, just tell Hank in chat."}
        </OpenNote>
      </Header>
      {board.tiers.map(({ tier, rows }) => (
        <TierRows key={tier} board={board} tier={tier} rows={rows} />
      ))}
    </Root>
  );
}
