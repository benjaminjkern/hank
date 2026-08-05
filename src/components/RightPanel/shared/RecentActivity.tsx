"use client";

import styled from "styled-components";

import { relativeTime } from "@/utils/date";

import { useExpandable } from "./useExpandable";

// Shared "Recent activity" / timeline block used by the job, company, and
// opportunity right-panel views. Renders its own heading + count + list +
// collapse toggle; the parent wraps it in whatever surface chrome (Card
// border, Section padding) fits the surrounding layout.
//
// Mapping notes:
// - context: optional secondary text rendered after the event type (e.g.
//   the job title on the company surface — answers "which role did this
//   event happen on" when the timeline aggregates across many jobs).
// - total: when the items array is a capped slice from the server, pass
//   the authoritative total so the "Show N more" count doesn't understate.

const PREVIEW_COUNT = 5;

export type RecentActivityItem = {
  id: string;
  type: string;
  occurredAt: string;
  notes: string | null;
  context: string | null;
};

const Header = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const HeaderCount = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  margin-left: ${({ theme }) => theme.space.xs};
`;

const ItemList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

// Item is a flex column: a top row (type/context on the left, time on the
// right) and an optional notes row underneath. Flex (rather than grid with
// `grid-column: 1 / -1`) keeps the notes line a plain block child — easier
// to reason about and immune to grid auto-placement edge cases.
const Item = styled.li`
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
`;

const ItemTopRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.md};
`;

// Raw enum-style event type ("CLOSED", "SHORTLISTED", "STATUS_CHANGED"…) in the
// accent color + mono font, so the "what happened" cue reads at a glance over
// the relative time on the right.
const TypeText = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
`;

const ContextText = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`;

const When = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  white-space: nowrap;
`;

const NotesLine = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  padding-left: ${({ theme }) => theme.space.sm};
  line-height: 1.4;
`;

const Placeholder = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
`;

const ToggleButton = styled.button`
  margin-top: ${({ theme }) => theme.space.sm};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  padding: 2px 0;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.accentHover};
  }
`;

// The list body without the heading — the part that's genuinely shared. Use
// this directly when the surrounding surface already supplies its own header
// chrome (e.g. the company page's Card + SectionHead, kept consistent with
// its sibling cards). `RecentActivity` wraps this with the inline mono header
// used by the job + opportunity single-card layouts.
export function RecentActivityList({
  items,
  total,
  emptyText = "No activity yet.",
}: {
  items: RecentActivityItem[];
  total?: number;
  emptyText?: string;
}) {
  const { visible, truncated, canCollapse, expand, collapse } = useExpandable(
    items,
    PREVIEW_COUNT,
  );
  // `items` may be a server-capped slice, so derive the hidden count from the
  // authoritative total rather than the hook's items-based hiddenCount.
  const knownTotal = total ?? items.length;
  const hiddenInPreview = knownTotal - visible.length;

  if (items.length === 0) return <Placeholder>{emptyText}</Placeholder>;

  return (
    <>
      <ItemList>
        {visible.map((e) => (
          <Item key={e.id}>
            <ItemTopRow>
              <div>
                <TypeText>{e.type}</TypeText>
                {e.context && <ContextText> · {e.context}</ContextText>}
              </div>
              <When>{relativeTime(e.occurredAt)}</When>
            </ItemTopRow>
            {e.notes && <NotesLine>{e.notes}</NotesLine>}
          </Item>
        ))}
      </ItemList>
      {truncated && hiddenInPreview > 0 && (
        <ToggleButton onClick={expand}>
          Show {hiddenInPreview} more
        </ToggleButton>
      )}
      {!truncated && canCollapse && (
        <ToggleButton onClick={collapse}>Collapse</ToggleButton>
      )}
    </>
  );
}

export function RecentActivity({
  items,
  total,
  emptyText = "No activity yet.",
}: {
  items: RecentActivityItem[];
  total?: number;
  emptyText?: string;
}) {
  const knownTotal = total ?? items.length;
  return (
    <>
      <Header>
        Recent activity
        {knownTotal > 0 && <HeaderCount>· {knownTotal}</HeaderCount>}
      </Header>
      <RecentActivityList items={items} total={total} emptyText={emptyText} />
    </>
  );
}
