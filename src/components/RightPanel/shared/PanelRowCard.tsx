"use client";

// The bordered row card the negotiation panels draw — shortlist board rows and
// discovery candidates. `$pending` takes the accent border, which is how both
// surfaces say "you changed this and it hasn't been sent yet".
//
// Deliberately NOT hover-lit and not a click target: the marks are their own
// buttons and opening a row is its own explicit button, so a card that lights up
// under the cursor promises a click that isn't there.
//
// Shared because the two are the same object with different contents: the
// second copy would have drifted the way every other per-surface
// re-implementation in this app has.

import styled from "styled-components";

export const PanelRowCard = styled.div<{ $pending?: boolean }>`
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

// The "send what I marked" pill both panels put in their header. Text rather
// than an icon: it's the one control that ends the negotiation, so it says so.
export const PanelSendChangesButton = styled.button`
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
