"use client";

// Shared "suggest the top item, confirm, or open the full list" machine used by
// the next-company and next-job pickers. Both widgets default to a single
// highlighted suggestion (the top *active* item) with an action-specific
// confirm button. "See full list" opens the existing multi-section list;
// picking a row there returns to the confirm card pointed at that row
// (select-then-confirm, not act-immediately). See docs/ui.md →
// "Suggestion picker (confirm-first widgets)".

import { useState, type ReactNode } from "react";
import styled from "styled-components";

import { truncate } from "@/utils/text";

type SuggestionView = "confirm" | "list";

// `defaultSuggestion` is the top *active* item (first immediate company / first
// shortlisted job), or null when there is none — in which case the widget opens
// straight to the full list. `selected` is whatever the confirm card is
// currently pointed at: the default suggestion, or a row the user chose from
// the list. View state is intentionally ephemeral (resets on remount) — the
// underlying payload is the source of truth, not which view was open.
export function useSuggestionPicker<T>(defaultSuggestion: T | null) {
  const [view, setView] = useState<SuggestionView>(
    defaultSuggestion ? "confirm" : "list",
  );
  const [selected, setSelected] = useState<T | null>(defaultSuggestion);
  return {
    view,
    selected,
    // confirm → list
    seeAll: () => setView("list"),
    // list → confirm (no row change; only meaningful when `selected` is set)
    back: () => setView("confirm"),
    // list → confirm, pointing the card at `row`
    choose: (row: T) => {
      setSelected(row);
      setView("confirm");
    },
  };
}

// The single highlighted suggestion shown in the confirm view's body. `avatar`
// is optional (the job picker has no logos). The caller renders the action
// buttons in the WidgetShell footer.
export function SuggestionCard({
  avatar,
  name,
  subtitle,
}: {
  avatar?: ReactNode;
  name: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <CardBox>
      {avatar}
      <CardText>
        <CardName>{name}</CardName>
        {subtitle != null && subtitle !== "" && (
          <CardSubtitle>{subtitle}</CardSubtitle>
        )}
      </CardText>
    </CardBox>
  );
}

// Truncate a name for use inside an action-specific button label so a long
// company name / job title doesn't blow out the button — the full name is
// already shown in the SuggestionCard above it.
export function truncateLabel(value: string, max = 40): string {
  return truncate(value.trim(), max);
}

const CardBox = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgMuted};
`;

const CardText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

const CardName = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CardSubtitle = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// Text-style button for the "See full list" / "Back" navigation affordances —
// visually subordinate to the primary confirm + the secondary action buttons.
export const LinkButton = styled.button`
  background: transparent;
  border: none;
  color: ${({ theme }) => theme.colors.accent};
  font-size: 13px;
  font-weight: 600;
  padding: 8px 6px;
  cursor: pointer;
  &:not(:disabled):hover {
    text-decoration: underline;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;
