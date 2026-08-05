"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { signOutAction } from "@/server/auth/actions";
import { initial } from "@/utils/text";

import type { TopBarUser } from "./TopBar";

const Wrap = styled.div`
  position: relative;
`;

const Trigger = styled.button`
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`;

const Menu = styled.div`
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  padding: ${({ theme }) => theme.space.xs};
  z-index: 100;
`;

const Identity = styled.div`
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  margin-bottom: ${({ theme }) => theme.space.xs};
`;

const IdentityName = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const IdentityEmail = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  word-break: break-all;
`;

const Item = styled.button`
  display: block;
  width: 100%;
  text-align: left;
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  background: transparent;
  border: none;
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;
  cursor: pointer;
  border-radius: ${({ theme }) => theme.radius.sm};
  font-family: inherit;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const ItemLink = styled(Link)`
  display: block;
  width: 100%;
  text-align: left;
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;
  text-decoration: none;
  border-radius: ${({ theme }) => theme.radius.sm};
  font-family: inherit;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

export function UserMenu({ user }: { user: TopBarUser }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <Wrap ref={wrapRef}>
      <Trigger
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.image} alt="" />
        ) : (
          initial(user.name || user.email || "?")
        )}
      </Trigger>
      {open ? (
        <Menu role="menu">
          <Identity>
            {user.name ? <IdentityName>{user.name}</IdentityName> : null}
            {user.email ? <IdentityEmail>{user.email}</IdentityEmail> : null}
          </Identity>
          <ItemLink
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Settings
          </ItemLink>
          <form action={signOutAction}>
            <Item type="submit" role="menuitem">
              Sign out
            </Item>
          </form>
        </Menu>
      ) : null}
    </Wrap>
  );
}
