"use client";

import Link from "next/link";
import styled from "styled-components";

type Props = {
  openNotes: number;
  deletionRecs: number;
  todayCostLabel: string;
  userCount: number;
  runsLast24h: number;
};

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xxl};
  font-family: ${({ theme }) => theme.font.body};
`;

const Container = styled.div`
  max-width: 880px;
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

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: ${({ theme }) => theme.space.md};
`;

const CardLink = styled(Link)`
  display: block;
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  text-decoration: none;
  color: inherit;
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const CardTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const CardHint = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: ${({ theme }) => theme.space.xs};
  line-height: 1.4;
`;

const CardNumber = styled.div<{ $emphasized?: boolean }>`
  font-size: 24px;
  font-weight: 600;
  margin-top: ${({ theme }) => theme.space.sm};
  color: ${({ theme, $emphasized }) =>
    $emphasized ? theme.colors.accent : theme.colors.text};
`;

const CardUnit = styled.span`
  font-size: 12px;
  font-weight: 400;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-left: ${({ theme }) => theme.space.xs};
`;

export function AdminIndexView({
  openNotes,
  deletionRecs,
  todayCostLabel,
  userCount,
  runsLast24h,
}: Props) {
  return (
    <Page>
      <Container>
        <Header>
          <H1>Admin</H1>
          <BackLink href="/">← Back to Hank</BackLink>
        </Header>
        <Grid>
          <CardLink href="/admin/notes">
            <CardTitle>Notes</CardTitle>
            <CardHint>
              Agent-recorded observations of user/agent confusion and flow
              friction.
            </CardHint>
            <CardNumber $emphasized={openNotes > 0}>
              {openNotes}
              <CardUnit>open</CardUnit>
            </CardNumber>
          </CardLink>
          <CardLink href="/admin/deletions">
            <CardTitle>Deletions</CardTitle>
            <CardHint>
              Companies and jobs flagged for deletion by Hank. Approve to
              hard-delete (cascades) or dismiss to clear the flag.
            </CardHint>
            <CardNumber $emphasized={deletionRecs > 0}>
              {deletionRecs}
              <CardUnit>pending</CardUnit>
            </CardNumber>
          </CardLink>
          <CardLink href="/admin/usage">
            <CardTitle>Usage</CardTitle>
            <CardHint>
              Token spend, cache hit rate, per-operation and per-session cost.
            </CardHint>
            <CardNumber>
              {todayCostLabel}
              <CardUnit>today</CardUnit>
            </CardNumber>
          </CardLink>
          <CardLink href="/admin/runs">
            <CardTitle>Runs</CardTitle>
            <CardHint>
              Inspect full agent run trees — exact model + params, every tool
              call I/O, and nested sub-agent interiors.
            </CardHint>
            <CardNumber $emphasized={runsLast24h > 0}>
              {runsLast24h}
              <CardUnit>last 24h</CardUnit>
            </CardNumber>
          </CardLink>
          <CardLink href="/admin/users">
            <CardTitle>Users</CardTitle>
            <CardHint>
              Manage who can use the server&apos;s Anthropic key as a fallback.
            </CardHint>
            <CardNumber>
              {userCount}
              <CardUnit>total</CardUnit>
            </CardNumber>
          </CardLink>
          <CardLink href="/admin/push-subscribe">
            <CardTitle>Push subscribe</CardTitle>
            <CardHint>
              Register this device for signup notifications. Open on each device
              (desktop / installed PWA) and paste the resulting JSON into the
              env.
            </CardHint>
          </CardLink>
        </Grid>
      </Container>
    </Page>
  );
}
