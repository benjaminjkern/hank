"use client";

import Link from "next/link";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";

import { HankLogo } from "../HankLogo";

import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

// Phone breakpoint for the TopBar only — below this the nav pills (Documents +
// Analytics, plus Admin) would push the row wider than the viewport and give
// the whole page a horizontal scrollbar. It's narrower than theme.breakpoints
// .narrow (900px, the panel split) because the bar only overflows on phones.
const PHONE = "560px";

// position+z-index keep the TopBar (and its UserMenu dropdown) above the
// ApiKeyBlockerModal backdrop (z-index 1000) so the user can still reach
// Settings / Sign out / Admin while the key modal is up. The Bar itself
// stays inside the SplitLayout grid row — position: relative just opts it
// into a stacking context.
const Bar = styled.header`
  position: relative;
  z-index: 1001;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.lg};
  padding: 0 ${({ theme }) => theme.space.lg};
  min-width: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgPanel};

  // Compact on phones: tighten gaps/padding (the wordmark also hides — see
  // BrandName) so the bar fits on one line without scrolling or wrapping.
  @media (max-width: ${PHONE}) {
    gap: ${({ theme }) => theme.space.sm};
    padding: 0 ${({ theme }) => theme.space.sm};
  }
`;

const Brand = styled.div`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  flex-shrink: 0;
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.2px;
`;

// The "Hank" wordmark next to the logo — dropped on phones to reclaim the
// width the nav pills need. The logo stays as the brand mark.
const BrandName = styled.span`
  @media (max-width: ${PHONE}) {
    display: none;
  }
`;

// Global-nav entry for the Documents view (the app's first persistent nav
// element). A button, not a Link, because the right panel is client-state
// driven — viewDocuments() swaps the panel mode without a route change.
const NavButton = styled.button<{ $active: boolean }>`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  background: ${({ theme, $active }) => ($active ? theme.colors.bgMuted : "transparent")};
  color: ${({ theme, $active }) => ($active ? theme.colors.accent : theme.colors.textMuted)};
  border: 1px solid
    ${({ theme, $active }) => ($active ? theme.colors.border : "transparent")};
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  @media (max-width: ${PHONE}) {
    padding: 4px 8px;
  }
`;

const Spacer = styled.div`
  flex: 1;
`;

const Right = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  flex-shrink: 0;
`;

const AdminLink = styled(Link)`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 4px 10px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.textMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

export interface TopBarUser {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  isAdmin: boolean;
}

export function TopBar({ user }: { user: TopBarUser }) {
  const panelMode = useChatStore((s) => s.panelMode);
  const viewDocuments = useChatStore((s) => s.viewDocuments);
  const viewAnalytics = useChatStore((s) => s.viewAnalytics);
  const setActivePanel = useChatStore((s) => s.setActivePanel);

  // Bring the right panel into view: narrow viewports flip to the right tab,
  // wide viewports un-collapse it if the user had it stowed.
  function surfaceRightPanel() {
    setActivePanel("right");
    if (useChatStore.getState().rightCollapsed) {
      useChatStore.getState().toggleRightCollapsed();
    }
  }

  function openDocuments() {
    viewDocuments();
    surfaceRightPanel();
  }

  function openAnalytics() {
    viewAnalytics();
    surfaceRightPanel();
  }

  return (
    <Bar>
      <Brand>
        <HankLogo size={20} />
        <BrandName>Hank</BrandName>
      </Brand>
      <NavButton $active={panelMode === "documents"} onClick={openDocuments}>
        Documents
      </NavButton>
      <NavButton $active={panelMode === "analytics"} onClick={openAnalytics}>
        Analytics
      </NavButton>
      <Spacer />
      <Right>
        {user.isAdmin && <AdminLink href="/admin">Admin</AdminLink>}
        <ThemeToggle />
        <UserMenu user={user} />
      </Right>
    </Bar>
  );
}
