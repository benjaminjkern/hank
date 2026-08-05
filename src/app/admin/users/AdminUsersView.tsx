"use client";

import Link from "next/link";
import styled from "styled-components";

import { shortDate } from "@/utils/date";

import { setCanUseServerKey } from "./actions";

export type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
  canUseServerKey: boolean;
  keyHint: string | null;
  keyUpdatedAt: string | null;
  createdAt: string;
  // null when the user has no live (non-ended) session yet — e.g. a freshly
  // seeded user who hasn't loaded the app. The Session column renders "—"
  // in that case.
  activeSessionId: string | null;
};

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xxl};
  font-family: ${({ theme }) => theme.font.body};
`;

const Container = styled.div`
  max-width: 960px;
  margin: 0 auto;
`;

const Header = styled.header`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: ${({ theme }) => theme.space.xl};
`;

const H1 = styled.h1`
  font-size: 22px;
  font-weight: 600;
  margin: 0;
`;

const BackLink = styled(Link)`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  overflow: hidden;
`;

const Th = styled.th`
  text-align: left;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgMuted};
`;

const Td = styled.td`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  vertical-align: middle;
`;

const Mono = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
`;

const Muted = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Pill = styled.span<{ $tone: "ok" | "warn" | "muted" }>`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $tone }) =>
    $tone === "ok"
      ? theme.colors.success
      : $tone === "warn"
        ? theme.colors.danger
        : theme.colors.textMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
`;

const SessionLink = styled(Link)`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`;

const ToggleButton = styled.button<{ $on: boolean }>`
  font-family: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  border: 1px solid
    ${({ theme, $on }) => ($on ? theme.colors.accent : theme.colors.border)};
  background: ${({ theme, $on }) =>
    $on ? theme.colors.accent : theme.colors.bgMuted};
  color: ${({ theme, $on }) =>
    $on ? theme.colors.onAccent : theme.colors.text};
`;

export function AdminUsersView({ users }: { users: AdminUserRow[] }) {
  return (
    <Page>
      <Container>
        <Header>
          <H1>Users</H1>
          <BackLink href="/admin">← Back to Admin</BackLink>
        </Header>
        <Table>
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>Name</Th>
              <Th>Own key</Th>
              <Th>Server key</Th>
              <Th>Admin</Th>
              <Th>Session</Th>
              <Th>Joined</Th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <Td>{u.email ?? <Muted>—</Muted>}</Td>
                <Td>{u.name ?? <Muted>—</Muted>}</Td>
                <Td>
                  {u.keyHint ? (
                    <Pill $tone="ok" title={u.keyUpdatedAt ?? undefined}>
                      <Mono>sk-…{u.keyHint}</Mono>
                    </Pill>
                  ) : (
                    <Pill $tone="muted">none</Pill>
                  )}
                </Td>
                <Td>
                  <form action={setCanUseServerKey}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={String(!u.canUseServerKey)}
                    />
                    <ToggleButton type="submit" $on={u.canUseServerKey}>
                      {u.canUseServerKey ? "Enabled" : "Disabled"}
                    </ToggleButton>
                  </form>
                </Td>
                <Td>
                  {u.isAdmin ? <Pill $tone="ok">admin</Pill> : <Muted>—</Muted>}
                </Td>
                <Td>
                  {u.activeSessionId ? (
                    <SessionLink href={`/admin/session/${u.activeSessionId}`}>
                      view →
                    </SessionLink>
                  ) : (
                    <Muted>—</Muted>
                  )}
                </Td>
                <Td>
                  <Muted>{shortDate(u.createdAt)}</Muted>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Container>
    </Page>
  );
}
