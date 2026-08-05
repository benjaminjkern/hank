"use client";

import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { HankLogo } from "@/components/HankLogo";

import { HankRain } from "./HankRain";

// 100vh on iOS Safari counts the URL-bar area, so a page sized to 100vh ends
// up taller than the visible viewport and the body becomes scrollable for no
// apparent reason. 100dvh tracks the current visible height. Keep 100vh as a
// fallback for older browsers that don't know dvh.
const Wrap = styled.main`
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.bg};
  overflow: hidden;
  overscroll-behavior: none;
`;

const Card = styled.div`
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 380px;
  background: ${({ theme }) => `${theme.colors.bgPanel}cc`};
  backdrop-filter: blur(8px);
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  padding: ${({ theme }) => theme.space.xl};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.lg};
`;

const Brand = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
`;

const BrandRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  font-weight: 600;
  font-size: 18px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
`;

const Subtitle = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`;

const Button = styled.button`
  width: 100%;
  height: 40px;
  padding: 0 ${({ theme }) => theme.space.md};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.space.sm};

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const ProviderIcon = styled.span`
  display: inline-flex;
  width: 16px;
  height: 16px;

  & > svg {
    width: 100%;
    height: 100%;
  }
`;

const Error = styled.div`
  color: ${({ theme }) => theme.colors.danger};
  background: ${({ theme }) => theme.colors.bgMuted};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 13px;
`;

const ChuteButton = styled.button`
  position: fixed;
  bottom: ${({ theme }) => theme.space.lg};
  right: ${({ theme }) => theme.space.lg};
  z-index: 10;
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.md}`};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.bgHover};
    color: ${({ theme }) => theme.colors.text};
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
`;

const errorMessages: Record<string, string> = {
  OAuthAccountNotLinked:
    "Another account already exists with this email. Sign in with the original provider.",
  AccessDenied: "Sign-in was cancelled.",
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.2-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.4 0 10.3-2.1 14-5.4l-6.5-5.3c-2 1.5-4.6 2.4-7.5 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.5 39.5 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.7l6.5 5.3C40.9 35.6 44 30.3 44 24c0-1.2-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 .5C5.6.5.5 5.6.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.2-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2.9-.3 2-.4 3-.4s2.1.1 3 .4c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.2 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.6 18.4.5 12 .5z"
      />
    </svg>
  );
}

export function SignInPanel({
  error,
  googleAction,
  githubAction,
}: {
  error?: string;
  googleAction: () => Promise<void>;
  githubAction: () => Promise<void>;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [groundDisabled, setGroundDisabled] = useState(false);
  const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
    },
    [],
  );

  const openChute = () => {
    setGroundDisabled(true);
    if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
    restoreTimeoutRef.current = setTimeout(() => {
      setGroundDisabled(false);
      restoreTimeoutRef.current = null;
    }, 5000);
  };

  return (
    <Wrap>
      <HankRain
        cardRef={cardRef}
        groundDisabled={groundDisabled}
        onCapReached={openChute}
      />
      <Card ref={cardRef}>
        <Brand>
          <BrandRow>
            <HankLogo size={24} />
            Hank
          </BrandRow>
          <Subtitle>Let&apos;s get you hired.</Subtitle>
        </Brand>
        <Title>Sign in</Title>
        {error ? (
          <Error>{errorMessages[error] || "Sign-in failed. Try again."}</Error>
        ) : null}
        <form action={googleAction}>
          <Button type="submit">
            <ProviderIcon>
              <GoogleMark />
            </ProviderIcon>
            Continue with Google
          </Button>
        </form>
        <form action={githubAction}>
          <Button type="submit">
            <ProviderIcon>
              <GitHubMark />
            </ProviderIcon>
            Continue with GitHub
          </Button>
        </form>
      </Card>
      <ChuteButton type="button" onClick={openChute} disabled={groundDisabled}>
        {groundDisabled ? "chute open…" : "open chute"}
      </ChuteButton>
    </Wrap>
  );
}
