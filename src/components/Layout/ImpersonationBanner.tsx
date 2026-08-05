"use client";

import Link from "next/link";
import styled from "styled-components";

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  padding: 6px ${({ theme }) => theme.space.lg};
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.onAccent};
  background: ${({ theme }) => theme.colors.danger};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`;

const BackLink = styled(Link)`
  color: ${({ theme }) => theme.colors.onAccent};
  text-decoration: underline;
  &:hover {
    opacity: 0.85;
  }
`;

export function ImpersonationBanner({ targetEmail }: { targetEmail: string }) {
  return (
    <Bar>
      <span>Viewing {targetEmail}&apos;s session — read-only</span>
      <BackLink href="/admin/users">← Back to Users</BackLink>
    </Bar>
  );
}
