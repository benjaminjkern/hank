// Chrome shared by more than one Analytics file: the section card and its
// header, the empty state, the controls row, and the small list primitives.

import styled, { type DefaultTheme } from "styled-components";

export const Card = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  overflow: hidden;
`;

export const SectionHead = styled.div`
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
`;

export const SectionTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

export const SectionCount = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: right;
`;

export const Empty = styled.div`
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.lg}`};
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textSubtle};
  text-align: center;
  line-height: 1.5;
`;

export const ControlsRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`;

export const ToggleLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  user-select: none;
  input {
    cursor: pointer;
    accent-color: ${({ theme }) => theme.colors.accent};
  }
`;

export const Dot = styled.span<{ $color: (t: DefaultTheme) => string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${({ theme, $color }) => $color(theme)};
`;

export const MoreButton = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
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
