import styled from "styled-components";

import type { ExpandableToggle } from "./useExpandable";

// The "Show N more" / "Collapse" row under a list capped by useExpandable.
// Renders nothing while the whole list fits under its cap.
//
// `topBorder` is for lists whose rows separate with a border-top, so the
// toggle carries on the same rule; lists whose rows separate with a
// border-bottom already draw the line above it.
const ToggleRow = styled.button<{ $topBorder: boolean }>`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  ${({ theme, $topBorder }) =>
    $topBorder ? `border-top: 1px solid ${theme.colors.border};` : ""}
  background: transparent;
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  text-align: center;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

export function ShowMoreToggle({
  expandable: { truncated, canCollapse, hiddenCount, expand, collapse },
  noun,
  topBorder = false,
}: {
  expandable: ExpandableToggle;
  // What the hidden rows are, when "Show 3 more" alone is ambiguous.
  noun?: readonly [singular: string, plural: string];
  topBorder?: boolean;
}) {
  if (truncated) {
    const what = noun ? ` ${hiddenCount === 1 ? noun[0] : noun[1]}` : "";
    return (
      <ToggleRow type="button" $topBorder={topBorder} onClick={expand}>
        Show {hiddenCount} more{what}
      </ToggleRow>
    );
  }
  if (canCollapse) {
    return (
      <ToggleRow type="button" $topBorder={topBorder} onClick={collapse}>
        Collapse
      </ToggleRow>
    );
  }
  return null;
}
