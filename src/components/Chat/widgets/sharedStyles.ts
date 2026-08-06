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

// A selectable card, not a line of text with a tickbox: it's a `label`, so the
// whole row toggles, and it carries a border so a selected row reads as chosen
// at a glance rather than only at the 15px control. Background stays
// transparent — the WidgetShell card underneath is already `bgPanel`, so a
// panel-colored row would vanish into it and only the border would show.
export const SuggestionRow = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  transition:
    border-color 0.12s ease,
    background 0.12s ease;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  &:has(input:checked) {
    border-color: ${({ theme }) => theme.colors.accent};
    background: ${({ theme }) => theme.colors.bgMuted};
  }
  &:has(input:focus-visible) {
    outline: 2px solid ${({ theme }) => theme.colors.accent};
    outline-offset: 2px;
  }
`;

// The one themed tick control in the chat layer. Native `appearance` can't be
// themed past `accent-color`, which leaves the box itself the OS grey — so the
// control is drawn here and the input keeps its semantics.
//
// It serves BOTH shapes: the checklist passes `type="checkbox"`, the
// disambiguation picker passes `type="radio"` and needs a circle with a dot.
// Style the type selectors, not a prop — the shape follows the input's actual
// behavior and can't be set to disagree with it.
export const SuggestionCheckbox = styled.input`
  appearance: none;
  flex-shrink: 0;
  margin: 2px 0 0;
  width: 15px;
  height: 15px;
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  border-radius: 4px;
  background: ${({ theme }) => theme.colors.bgMuted};
  cursor: pointer;
  display: inline-grid;
  place-content: center;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;

  &::after {
    content: "";
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  &[type="checkbox"]::after {
    width: 8px;
    height: 4px;
    border-left: 2px solid ${({ theme }) => theme.colors.onAccent};
    border-bottom: 2px solid ${({ theme }) => theme.colors.onAccent};
    transform: rotate(-45deg) translate(1px, -1px);
  }

  &[type="radio"] {
    border-radius: 50%;
  }
  &[type="radio"]::after {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${({ theme }) => theme.colors.onAccent};
  }

  &:checked {
    background: ${({ theme }) => theme.colors.accent};
    border-color: ${({ theme }) => theme.colors.accent};
  }
  &:checked::after {
    opacity: 1;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
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
