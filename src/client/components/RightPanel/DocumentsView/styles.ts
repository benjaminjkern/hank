// Chrome shared by more than one Documents file: the page layout, the card
// body, and the text / button primitives the sub-pages compose.

import styled from "styled-components";

export const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
`;

export const PageHead = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
  margin-bottom: ${({ theme }) => theme.space.xs};
`;

// Card body wrapper for the narrative / resume / files sub-pages.
export const CardPad = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
`;

export const CardHint = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  line-height: 1.4;
  margin-bottom: ${({ theme }) => theme.space.md};
`;

export const Prose = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  white-space: pre-wrap;
  line-height: 1.55;
  word-break: break-word;
`;

export const EmptyHint = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
`;

export const InlineButton = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
  &:disabled {
    color: ${({ theme }) => theme.colors.textSubtle};
    cursor: not-allowed;
  }
`;
