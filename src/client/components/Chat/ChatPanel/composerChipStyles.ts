import styled from "styled-components";

export const AttachmentRow = styled.div`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg} 0`};
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs};
`;

export const PendingChip = styled.div<{
  $status: "uploading" | "uploaded" | "error";
}>`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.md}`};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid
    ${({ theme, $status }) =>
      $status === "error" ? theme.colors.danger : theme.colors.border};
  border-radius: 999px;
  font-size: 12px;
  color: ${({ theme, $status }) =>
    $status === "error" ? theme.colors.danger : theme.colors.text};
  max-width: 360px;
`;

export const PendingName = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const PendingStatus = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

export const ChipClose = styled.button`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
  line-height: 1;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

// The second half of the dismiss: × arms it, this confirms. Destructive enough
// to earn the danger colour and a deliberate second click — the marks it throws
// away can't be recovered from the UI.
export const ChipConfirm = styled.button`
  color: ${({ theme }) => theme.colors.danger};
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  &:hover {
    text-decoration: underline;
  }
`;
