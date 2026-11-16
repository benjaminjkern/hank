import { css } from "styled-components";

// The TopBar's square icon-affordance chrome — one 28px hit target, muted
// until hover. Shared as a css block rather than a component because its
// consumers are different elements (ThemeToggle is a <button>, the view-source
// link is an <a>), and `as="a"` on a styled button loses the anchor's typing.
export const iconAction = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  transition:
    background 120ms ease,
    color 120ms ease;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
    color: ${({ theme }) => theme.colors.text};
  }
`;
