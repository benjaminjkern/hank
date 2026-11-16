import styled from "styled-components";

import { jobStatusColor } from "@/shared/statusColors";

// Styled pieces used by more than one dashboard file. A piece only one file
// renders lives in that file.

export const Group = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  margin-bottom: ${({ theme }) => theme.space.md};
  overflow: hidden;
`;

export const GroupCount = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
  flex-shrink: 0;
`;

export const Title = styled.div`
  color: ${({ theme }) => theme.colors.text};
`;

// Title + meta column inside a grid row. min-width: 0 lets the column shrink
// below its content's intrinsic width so the single-line JobMeta truncates
// with an ellipsis instead of forcing the grid to overflow and shove the
// status pill off the edge of the box.
export const RowMain = styled.div`
  min-width: 0;
`;

// `$appliedAt` + `$now` are only passed for job-status pills; without them
// jobStatusColor falls back to the plain tone, so company/opportunity pills can
// route through it unchanged.
export const StatusPill = styled.span<{
  $status: string;
  $appliedAt?: string | null;
  $now?: number;
}>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 7px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status, $appliedAt, $now }) =>
    jobStatusColor(theme, $status, $appliedAt, $now)};
  white-space: nowrap;
`;

export const EmptyRow = styled.div`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  font-size: 12px;
  font-style: italic;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// Cap the inline job list inside each company / opportunity box; the rest
// hides behind a show-more toggle. Matches the company-detail page's preview.
export const DASHBOARD_PREVIEW_COUNT = 5;

// No wrapper opacity — dimming the whole section made rows read as
// non-interactive. Muted text colors on the row itself already signal
// "closed" without sapping the click affordance.
export const ClosedSection = styled.div``;

export const ClosedRow = styled.button.attrs({ type: "button" })`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  align-items: center;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  margin-bottom: ${({ theme }) => theme.space.xs};
  text-align: left;
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Left side of a closed-company row: logo chip + company name (+ optional
// skip note underneath). Stays one cell of the parent grid so the skip
// reason label keeps its right-aligned position.
export const ClosedRowLeft = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

export const CloseReasonLabel = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
`;

// Freeform skip note under the company name when present. Mirrors the
// company page's closed-jobs treatment — visible inline rather than buried
// in a hover tooltip.
export const CloseNoteLine = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 2px;
  line-height: 1.4;
`;
