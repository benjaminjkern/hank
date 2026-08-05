"use client";

import Link from "next/link";
import styled from "styled-components";

const Wrap = styled.main`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.bg};
`;

const Card = styled.div`
  width: 100%;
  max-width: 380px;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  padding: ${({ theme }) => theme.space.xl};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
`;

const Text = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
  line-height: 1.5;
`;

const Code = styled.div`
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  font-size: 12px;
`;

const Back = styled(Link)`
  color: ${({ theme }) => theme.colors.accent};
  font-size: 13px;
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`;

const messages: Record<string, string> = {
  Configuration:
    "There's a server-side configuration problem. Reach out to the admin.",
  AccessDenied: "You don't have permission to sign in.",
};

export function AuthErrorPanel({ code }: { code?: string }) {
  const msg =
    (code && messages[code]) || "Something went wrong during sign-in.";
  return (
    <Wrap>
      <Card>
        <Title>Sign-in error</Title>
        <Text>{msg}</Text>
        {code ? <Code>code: {code}</Code> : null}
        <Back href="/signin">← Try again</Back>
      </Card>
    </Wrap>
  );
}
