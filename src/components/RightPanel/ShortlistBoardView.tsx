"use client";

// The shortlist board — every role STILL being considered at one company, with
// the deciding pass's one-line reason per row. Closed, delisted and applied-to
// roles are not here: they're decided, the user watched them go, and the
// company page's never-pursued list is where they live. Every row still open to
// a decision carries the same three marks (Pick / Maybe / Pass), pre-selected
// to what Hank proposed, so agreeing costs no clicks; clicking the current mark
// clears it to undecided. A row the user re-marks KEEPS its position, flagged
// pending, until their next chat message relays it — rows never move out from
// under the cursor. Nothing is final until Hank commits the board in chat.

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

// The card highlights on hover but is NOT itself a click target — navigation is
// the explicit "View role" button in the footer. Marking a row and opening it
// are different intents, and burying one inside the other's hit area put three
// buttons inside a fourth.
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

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
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

const StanceButton = styled.button<{ $active?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Square rather than the old text pill's 2px/10px — an icon has no width of
     its own to shape the target, and 28px keeps it tappable. */
  width: 28px;
  height: 28px;
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

// The screen has two groups, not one per tier. `consider` is everything the
// shortlist pass actually ranked: those rows arrive with their mark
// pre-selected, so a heading per verdict only restated what the marks already
// say. `aside` is the tail nobody ranked — auto-filtered, unread, or parked —
// which is worth auditing but not worth the vertical space by default.
type BoardGroup = "consider" | "aside";

const GROUP_OF_TIER: Record<ShortlistBoardTier, BoardGroup> = {
  picks: "consider",
  borderline: "consider",
  pass: "consider",
  undecided: "consider",
  notReadYet: "aside",
  onHold: "aside",
  filteredThisRound: "aside",
};

const ASIDE_LABEL = "Probably not worth a look";
const ASIDE_HINT =
  "Ruled out before the shortlist, not read yet, or parked on hold";

// 16px, stroke-only, inheriting the button's color so the $active accent
// applies for free — same convention as ThemeToggle's icons. `aria-hidden`
// because the accessible name comes from the button's aria-label.
function iconProps() {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function ShortlistIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

function DeferIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M2.5 9.5c1.4-2.8 2.8-2.8 4.2 0s2.8 2.8 4.2 0" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// The three marks, in board order. Every row that can still be decided offers
// all three — there is no separate "reconsider" affordance, and the one already
// set is pre-selected, so agreeing with Hank is doing nothing at all.
//
// `value` is the wire vocabulary (pick / borderline / pass, what the board and
// the agent speak); `label` is the LIFECYCLE word the mark lands the role on,
// which is what the rest of the app shows on the status pill. They differ on
// purpose — naming the button "Pick" left no way to tell which status it sets.
const STANCES = [
  { value: "pick", label: "Shortlist", Icon: ShortlistIcon },
  { value: "borderline", label: "Defer", Icon: DeferIcon },
  { value: "pass", label: "Close", Icon: CloseIcon },
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

  // Clicking the mark a row already carries clears it — that's the un-select,
  // and it lands the row in Undecided rather than forcing a choice.
  async function mark(next: StanceValue) {
    if (busy) return;
    setBusy(true);
    try {
      await editShortlistBoard(
        companyId,
        row.jobId,
        next === stance ? "undecided" : next,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <RowCard $pending={row.pending}>
      <RowTop>
        <RowTitle>{row.title}</RowTitle>
      </RowTop>
      {rowMeta(row) && <RowMeta>{rowMeta(row)}</RowMeta>}
      {row.reason && <RowReason>{row.reason}</RowReason>}
      {row.matchBucket && row.stanceable && (
        <ScanTag>
          First read: {row.matchBucket.toLowerCase()}
          {row.matchReason ? ` — ${row.matchReason}` : ""}
        </ScanTag>
      )}
      <StanceRow>
        {!readOnly &&
          row.stanceable &&
          STANCES.map((s) => (
            <StanceButton
              key={s.value}
              $active={stance === s.value}
              disabled={busy}
              // The icon carries no text, so the button needs its own
              // accessible name — and the tooltip has to say what the
              // mark does now that the label isn't on screen.
              aria-label={s.label}
              aria-pressed={stance === s.value}
              title={
                stance === s.value
                  ? `${s.label} — click again to leave it undecided`
                  : s.label
              }
              onClick={() => void mark(s.value)}
            >
              <s.Icon />
            </StanceButton>
          ))}
        {busy && <ScanTag>saving…</ScanTag>}
        <ViewRoleButton onClick={() => void viewJob(row.jobId)}>
          View role →
        </ViewRoleButton>
      </StanceRow>
    </RowCard>
  );
}

function AsideGroup({
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
        <TierTitle>{ASIDE_LABEL}</TierTitle>
        <TierCount>{placed.length}</TierCount>
        {open && <ScanTag>— {ASIDE_HINT}</ScanTag>}
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
  const consider: PlacedRow[] = [];
  const aside: PlacedRow[] = [];
  for (const { tier, rows } of board.tiers) {
    const bucket = GROUP_OF_TIER[tier] === "consider" ? consider : aside;
    for (const row of rows) bucket.push({ tier, row });
  }

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
        {!board.open && (
          <OpenNote>
            This shortlist is locked in — nothing left to decide here. To change
            your mind on a role, just tell Hank in chat.
          </OpenNote>
        )}
      </Header>
      <TierSection>
        {consider.map(({ tier, row }) => (
          <BoardRow
            key={row.jobId}
            companyId={board.companyId}
            tier={tier}
            row={row}
          />
        ))}
      </TierSection>
      {aside.length > 0 && (
        <AsideGroup companyId={board.companyId} placed={aside} />
      )}
    </Root>
  );
}
