import styled from "styled-components";

import { HankLogo } from "../../HankLogo";

// Welcome-screen block — sits above the centered composer when the chat is
// empty. Only rendered in the empty state, so no need to collapse it.
const Hero = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.xl} ${theme.space.lg}`};
  text-align: center;
  flex: 0 0 auto;
`;

const HeroLogoWrap = styled.div`
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const HeroTitle = styled.div`
  font-size: 28px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.25;
`;

const HeroSubtitle = styled.div`
  font-size: 15px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

export function ChatHero() {
  return (
    <Hero>
      <HeroLogoWrap>
        <HankLogo size={64} />
      </HeroLogoWrap>
      <HeroTitle>Hi, I&apos;m Hank!</HeroTitle>
      <HeroSubtitle>Drop in your resume to get started</HeroSubtitle>
    </Hero>
  );
}
