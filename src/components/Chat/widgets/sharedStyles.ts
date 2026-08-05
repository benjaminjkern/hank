// Shared styled components for the pipeline widgets. The card chrome,
// header, title, and minimize control live in WidgetShell — these are the
// in-body primitives (text, buttons, suggestion lists) each widget composes
// inside the shell.

import styled from "styled-components";

export const Meta = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.45;
`;

export const ButtonRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

export const PrimaryButton = styled.button`
  background: ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.onAccent};
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  &:not(:disabled):hover {
    background: ${({ theme }) => theme.colors.accentHover};
  }
`;

export const SecondaryButton = styled.button`
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  &:not(:disabled):hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// No inner scroll cap — the WidgetShell Body is the single scroll region now,
// so the list flows naturally and the card scrolls as a whole.
export const SuggestionList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

export const SuggestionRow = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

export const SuggestionCheckbox = styled.input`
  margin-top: 3px;
  cursor: pointer;
`;

export const SuggestionBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

export const SuggestionName = styled.span`
  font-weight: 600;
`;

export const SuggestionReason = styled.span`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;
