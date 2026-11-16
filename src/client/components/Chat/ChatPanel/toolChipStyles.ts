import styled from "styled-components";

import type { ToolSegment } from "@/client/chatStore";

type ToolStatus = ToolSegment["status"];

export const ToolBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

export const ToolChip = styled.span<{ $status: ToolStatus }>`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status }) =>
    $status === "error"
      ? theme.colors.danger
      : $status === "done"
        ? theme.colors.success
        : theme.colors.textMuted};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};

  &::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${({ theme, $status }) =>
      $status === "error"
        ? theme.colors.danger
        : $status === "done"
          ? theme.colors.success
          : theme.colors.textSubtle};
  }
`;

// Header chip for a failed run. Danger-toned sibling of ToolChip — same pill
// geometry so the two expandable rows line up, with a warning glyph instead of
// the status dot.
export const ErrorChip = styled.span`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 10px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.danger};
  color: ${({ theme }) => theme.colors.danger};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  text-align: left;

  &::before {
    content: "⚠";
    font-size: 10px;
  }
`;

export const ToolProgress = styled.span`
  align-self: flex-start;
  padding-left: 22px;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// Click-anywhere header for an expandable tool chip. Wraps a ToolChip (or the
// shortlist-widget compact chip) plus a rotating caret, all inside a button
// for keyboard accessibility. Caret rotation mirrors the BucketCaret pattern
// from DashboardView.
export const ToolHeaderButton = styled.button`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
`;

export const ToolCaret = styled.span<{ $open: boolean }>`
  font-size: 9px;
  color: ${({ theme }) => theme.colors.textSubtle};
  display: inline-block;
  width: 8px;
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.12s ease;
`;

// Indented panel under the header showing input, result, and recursive
// children. Border-left stripe so the visual hierarchy of nested chips reads
// as a tree.
export const ToolExpanded = styled.div`
  margin: ${({ theme }) => `${theme.space.xs} 0 ${theme.space.sm} 6px`};
  padding-left: ${({ theme }) => theme.space.md};
  border-left: 2px solid ${({ theme }) => theme.colors.border};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
`;

export const ToolFieldLabel = styled.div`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

// Monospace pre with wrap + scroll cap. Long tool inputs / results stay
// readable without expanding the chat bubble horizontally past the viewport.
export const ToolPre = styled.pre`
  margin: 0;
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.text};
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
`;

export const ToolChildren = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;
