"use client";

import Link from "next/link";
import styled from "styled-components";

import { count, money } from "@/utils/format";

type AggCommon = {
  calls: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  webSearch: number;
  cost: number;
  serverCost: number;
  userCost: number;
};

export type UsageFilter =
  | { kind: "none" }
  | { kind: "user"; userId: string; email: string | null }
  | {
      kind: "session";
      sessionId: string;
      userId: string | null;
      email: string | null;
    };

export type UsageSummary = {
  filter: UsageFilter;
  totals: {
    today: number;
    sevenDay: number;
    thirtyDay: number;
    allTime: number;
  };
  // Bill-source split of all-time cost (within the active filter).
  billedToUs: number;
  billedToUsers: number;
  cacheReadTokens: number;
  cacheableInputTokens: number;
  cacheSavings: number;
  byOperation: Array<AggCommon & { operation: string }>;
  byModel: Array<AggCommon & { model: string }>;
  byUser: Array<AggCommon & { userId: string; email: string | null }>;
  daily: Array<{ date: string; cost: number }>;
  topSessions: Array<
    AggCommon & {
      sessionId: string;
      userId: string | null;
      email: string | null;
    }
  >;
  recent: Array<{
    createdAt: string;
    operation: string;
    model: string;
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    cost: number;
    notes: string | null;
    sessionId: string | null;
    billedToServer: boolean;
  }>;
  rowCount: number;
};

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xxl};
  font-family: ${({ theme }) => theme.font.body};
`;

const Container = styled.div`
  max-width: 1080px;
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

const Section = styled.section`
  margin-bottom: ${({ theme }) => theme.space.xl};
`;

const SectionTitle = styled.h2`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin: 0 0 ${({ theme }) => theme.space.sm};
`;

const StatCardGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: ${({ theme }) => theme.space.sm};
`;

const Card = styled.div`
  padding: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
`;

const StatLabel = styled.div`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.6px;
`;

const StatValue = styled.div`
  font-size: 22px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin-top: ${({ theme }) => theme.space.xs};
`;

const StatHint = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-top: 2px;
`;

const CacheCard = styled(Card)`
  display: flex;
  gap: ${({ theme }) => theme.space.xl};
  align-items: center;
`;

const CacheStat = styled.div``;

const TablesRow = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: ${({ theme }) => theme.space.lg};
  @media (max-width: 800px) {
    grid-template-columns: 1fr;
  }
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
`;

const Th = styled.th`
  text-align: left;
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
  font-weight: 500;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  white-space: nowrap;
`;

const ThNum = styled(Th)`
  text-align: right;
`;

const Td = styled.td`
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.text};
  vertical-align: top;
`;

const TdNum = styled(Td)`
  text-align: right;
  white-space: nowrap;
`;

const TdMuted = styled(Td)`
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Chart = styled.div`
  display: grid;
  grid-template-columns: repeat(30, 1fr);
  gap: 2px;
  align-items: end;
  height: 120px;
  padding: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
`;

const Bar = styled.div<{ $h: number; $empty: boolean }>`
  height: ${({ $h }) => `${$h}%`};
  min-height: ${({ $empty }) => ($empty ? "1px" : "2px")};
  background: ${({ theme, $empty }) =>
    $empty ? theme.colors.border : theme.colors.accent};
  border-radius: 2px;
  cursor: default;
`;

const ChartFooter = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  display: flex;
  justify-content: space-between;
  margin-top: ${({ theme }) => theme.space.xs};
`;

const SessionTag = styled(Link)`
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
`;

const RowCount = styled.span`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
`;

const FilterBanner = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  margin-bottom: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.accent};
  border-radius: ${({ theme }) => theme.radius.md};
  font-size: 13px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.text};
`;

const ClearLink = styled(Link)`
  margin-left: auto;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const UserTag = styled(Link)`
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
`;

const OpenLink = styled(Link)`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  text-decoration: none;
  margin-left: ${({ theme }) => theme.space.xs};
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
  }
`;

// Tiny "us" / "user" pill on each recent call showing which key paid.
const BillPill = styled.span<{ $server: boolean }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 1px 5px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme, $server }) =>
    $server ? theme.colors.textMuted : theme.colors.accent};
  border: 1px solid
    ${({ theme, $server }) => ($server ? theme.colors.border : theme.colors.accent)};
`;

export function AdminUsageView({ summary }: { summary: UsageSummary }) {
  const cacheHitRate =
    summary.cacheableInputTokens > 0
      ? (summary.cacheReadTokens / summary.cacheableInputTokens) * 100
      : 0;

  const maxDaily = summary.daily.reduce((m, d) => Math.max(m, d.cost), 0);

  const { filter } = summary;
  const filterLabel =
    filter.kind === "user"
      ? `user: ${filter.email ?? filter.userId}`
      : filter.kind === "session"
        ? `session: …${filter.sessionId.slice(-8)}${
            filter.email ? ` · ${filter.email}` : ""
          }`
        : null;

  return (
    <Page>
      <Container>
        <Header>
          <H1>Token usage & cost</H1>
          <BackLink href="/admin">← Admin home</BackLink>
        </Header>

        {filterLabel && (
          <FilterBanner>
            <span>Filtered → {filterLabel}</span>
            <ClearLink href="/admin/usage">clear filter ✕</ClearLink>
          </FilterBanner>
        )}

        <Section>
          <SectionTitle>Spend{filterLabel ? " (filtered)" : ""}</SectionTitle>
          <StatCardGrid>
            <Card>
              <StatLabel>Today</StatLabel>
              <StatValue>{money(summary.totals.today)}</StatValue>
              <StatHint>since midnight Pacific</StatHint>
            </Card>
            <Card>
              <StatLabel>Last 7d</StatLabel>
              <StatValue>{money(summary.totals.sevenDay)}</StatValue>
              <StatHint>rolling window</StatHint>
            </Card>
            <Card>
              <StatLabel>Last 30d</StatLabel>
              <StatValue>{money(summary.totals.thirtyDay)}</StatValue>
              <StatHint>rolling window</StatHint>
            </Card>
            <Card>
              <StatLabel>All-time</StatLabel>
              <StatValue>{money(summary.totals.allTime)}</StatValue>
              <StatHint>
                <RowCount>{count(summary.rowCount)} calls</RowCount>
              </StatHint>
            </Card>
          </StatCardGrid>
        </Section>

        <Section>
          <SectionTitle>Bill source (all-time)</SectionTitle>
          <CacheCard>
            <CacheStat>
              <StatLabel>Billed to us</StatLabel>
              <StatValue>{money(summary.billedToUs)}</StatValue>
              <StatHint>charged to our server API key</StatHint>
            </CacheStat>
            <CacheStat>
              <StatLabel>Billed to users&apos; keys</StatLabel>
              <StatValue>{money(summary.billedToUsers)}</StatValue>
              <StatHint>
                paid on users&apos; own keys — what we&apos;d have been charged
                at our rates
              </StatHint>
            </CacheStat>
          </CacheCard>
        </Section>

        <Section>
          <SectionTitle>Prompt cache</SectionTitle>
          <CacheCard>
            <CacheStat>
              <StatLabel>Hit rate</StatLabel>
              <StatValue>{cacheHitRate.toFixed(1)}%</StatValue>
              <StatHint>cache_read / (cache_read + input)</StatHint>
            </CacheStat>
            <CacheStat>
              <StatLabel>Savings</StatLabel>
              <StatValue>{money(summary.cacheSavings)}</StatValue>
              <StatHint>
                vs paying input rate on all {count(summary.cacheReadTokens)}{" "}
                cached tokens
              </StatHint>
            </CacheStat>
          </CacheCard>
        </Section>

        <Section>
          <SectionTitle>Daily cost (last 30 days, Pacific)</SectionTitle>
          <Chart>
            {summary.daily.map((d) => {
              const h = maxDaily > 0 ? (d.cost / maxDaily) * 100 : 0;
              return (
                <Bar
                  key={d.date}
                  $h={h}
                  $empty={d.cost === 0}
                  title={`${d.date} · ${money(d.cost)}`}
                />
              );
            })}
          </Chart>
          <ChartFooter>
            <span>{summary.daily[0]?.date}</span>
            <span>peak {money(maxDaily)}</span>
            <span>{summary.daily[summary.daily.length - 1]?.date}</span>
          </ChartFooter>
        </Section>

        <TablesRow>
          <Section>
            <SectionTitle>By operation</SectionTitle>
            <Card>
              <Table>
                <thead>
                  <tr>
                    <Th>op</Th>
                    <ThNum>calls</ThNum>
                    <ThNum>in</ThNum>
                    <ThNum>out</ThNum>
                    <ThNum>c_r</ThNum>
                    <ThNum>cost</ThNum>
                  </tr>
                </thead>
                <tbody>
                  {summary.byOperation.map((r) => (
                    <tr key={r.operation}>
                      <Td>{r.operation}</Td>
                      <TdNum>{count(r.calls)}</TdNum>
                      <TdNum>{count(r.input)}</TdNum>
                      <TdNum>{count(r.output)}</TdNum>
                      <TdNum>{count(r.cacheRead)}</TdNum>
                      <TdNum>{money(r.cost)}</TdNum>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </Section>

          <Section>
            <SectionTitle>By model</SectionTitle>
            <Card>
              <Table>
                <thead>
                  <tr>
                    <Th>model</Th>
                    <ThNum>calls</ThNum>
                    <ThNum>in</ThNum>
                    <ThNum>out</ThNum>
                    <ThNum>c_r</ThNum>
                    <ThNum>cost</ThNum>
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map((r) => (
                    <tr key={r.model}>
                      <Td>{r.model}</Td>
                      <TdNum>{count(r.calls)}</TdNum>
                      <TdNum>{count(r.input)}</TdNum>
                      <TdNum>{count(r.output)}</TdNum>
                      <TdNum>{count(r.cacheRead)}</TdNum>
                      <TdNum>{money(r.cost)}</TdNum>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </Section>
        </TablesRow>

        <Section>
          <SectionTitle>By user</SectionTitle>
          <Card>
            {summary.byUser.length === 0 ? (
              <TdMuted as="div">no rows in scope</TdMuted>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>user</Th>
                    <ThNum>calls</ThNum>
                    <ThNum>in</ThNum>
                    <ThNum>out</ThNum>
                    <ThNum>c_r</ThNum>
                    <ThNum>cost</ThNum>
                    <ThNum>u-key</ThNum>
                  </tr>
                </thead>
                <tbody>
                  {summary.byUser.map((u) => (
                    <tr key={u.userId}>
                      <Td>
                        <UserTag href={`/admin/usage?user=${u.userId}`}>
                          {u.email ?? `…${u.userId.slice(-8)}`}
                        </UserTag>
                      </Td>
                      <TdNum>{count(u.calls)}</TdNum>
                      <TdNum>{count(u.input)}</TdNum>
                      <TdNum>{count(u.output)}</TdNum>
                      <TdNum>{count(u.cacheRead)}</TdNum>
                      <TdNum>{money(u.cost)}</TdNum>
                      <TdNum>{u.userCost > 0 ? money(u.userCost) : "—"}</TdNum>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </Section>

        <Section>
          <SectionTitle>Top sessions by cost</SectionTitle>
          <Card>
            {summary.topSessions.length === 0 ? (
              <TdMuted as="div">no session-scoped rows yet</TdMuted>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>session</Th>
                    <Th>user</Th>
                    <ThNum>calls</ThNum>
                    <ThNum>in</ThNum>
                    <ThNum>out</ThNum>
                    <ThNum>c_r</ThNum>
                    <ThNum>cost</ThNum>
                  </tr>
                </thead>
                <tbody>
                  {summary.topSessions.map((s) => (
                    <tr key={s.sessionId}>
                      <Td>
                        <SessionTag
                          href={`/admin/usage?session=${s.sessionId}`}
                        >
                          …{s.sessionId.slice(-8)}
                        </SessionTag>
                        <OpenLink
                          href={`/admin/session/${s.sessionId}`}
                          title="open session"
                        >
                          ↗
                        </OpenLink>
                      </Td>
                      <Td>
                        {s.userId ? (
                          <UserTag href={`/admin/usage?user=${s.userId}`}>
                            {s.email ?? `…${s.userId.slice(-8)}`}
                          </UserTag>
                        ) : (
                          <TdMuted as="span">—</TdMuted>
                        )}
                      </Td>
                      <TdNum>{count(s.calls)}</TdNum>
                      <TdNum>{count(s.input)}</TdNum>
                      <TdNum>{count(s.output)}</TdNum>
                      <TdNum>{count(s.cacheRead)}</TdNum>
                      <TdNum>{money(s.cost)}</TdNum>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </Section>

        <Section>
          <SectionTitle>Recent calls</SectionTitle>
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>when</Th>
                  <Th>op</Th>
                  <Th>model</Th>
                  <ThNum>in</ThNum>
                  <ThNum>out</ThNum>
                  <ThNum>c_w</ThNum>
                  <ThNum>c_r</ThNum>
                  <ThNum>cost</ThNum>
                  <Th>key</Th>
                  <Th>notes</Th>
                </tr>
              </thead>
              <tbody>
                {summary.recent.map((r, i) => (
                  <tr key={`${r.createdAt}-${i}`}>
                    <TdMuted>
                      {r.createdAt.slice(0, 19).replace("T", " ")}
                    </TdMuted>
                    <Td>{r.operation}</Td>
                    <TdMuted>{r.model}</TdMuted>
                    <TdNum>{count(r.input)}</TdNum>
                    <TdNum>{count(r.output)}</TdNum>
                    <TdNum>{count(r.cacheCreate)}</TdNum>
                    <TdNum>{count(r.cacheRead)}</TdNum>
                    <TdNum>{money(r.cost)}</TdNum>
                    <Td>
                      <BillPill $server={r.billedToServer}>
                        {r.billedToServer ? "us" : "user"}
                      </BillPill>
                    </Td>
                    <TdMuted>{r.notes ?? ""}</TdMuted>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </Section>
      </Container>
    </Page>
  );
}
