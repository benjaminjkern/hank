"use client";

import Link from "next/link";
import { useState } from "react";
import styled from "styled-components";

import { relativeTime } from "@/utils/date";

export type BoardReaderRow = {
  id: string;
  matchKey: string;
  familyKey: string | null;
  sourceUrl: string;
  recipeJson: string | null;
  origin: string;
  health: string;
  lastRunAt: string | null;
  lastSucceededAt: string | null;
  jobsLastRun: number | null;
  missingLastRun: number | null;
  overlapLastRun: number | null;
  consecutiveFailures: number;
  needsBrowser: boolean;
  reconNote: string | null;
  reconnedAt: string | null;
  createdAt: string;
  companies: Array<{ name: string; slug: string }>;
};

type Props = { readers: BoardReaderRow[] };

// Grouped by board-software family and ordered by how many companies sit behind
// it, because that ordering IS the answer to "which of these deserves a
// hand-written provider next".
export function BoardReadersView({ readers }: Props) {
  const groups = groupByFamily(readers);
  const readable = readers.filter((r) => r.recipeJson != null).length;

  return (
    <Page>
      <Container>
        <Header>
          <div>
            <H1>Board readers</H1>
            <Sub>
              {readers.length} board{readers.length === 1 ? "" : "s"} no wired
              provider recognizes · {readable} readable · a family with several
              companies behind it is worth a real provider file
            </Sub>
          </div>
          <BackLink href="/admin">← admin</BackLink>
        </Header>

        {groups.length === 0 ? (
          <Empty>
            Nothing here yet. A row appears the first time a company&apos;s
            board isn&apos;t one of the wired ATSes.
          </Empty>
        ) : (
          groups.map(({ family, rows, companyCount }) => (
            <Group key={family}>
              <GroupHeader>
                <GroupName>{family}</GroupName>
                <GroupMeta>
                  {rows.length} board{rows.length === 1 ? "" : "s"} ·{" "}
                  {companyCount} compan{companyCount === 1 ? "y" : "ies"}
                </GroupMeta>
              </GroupHeader>
              {rows.map((r) => (
                <ReaderCard key={r.id} reader={r} />
              ))}
            </Group>
          ))
        )}
      </Container>
    </Page>
  );
}

function ReaderCard({ reader }: { reader: BoardReaderRow }) {
  const [open, setOpen] = useState(false);
  const state = reader.recipeJson
    ? reader.health === "QUARANTINED"
      ? "quarantined"
      : "readable"
    : reader.needsBrowser
      ? "needs browser"
      : "unreadable";

  return (
    <Card>
      <CardTop>
        <div>
          <BoardUrl href={reader.sourceUrl} target="_blank" rel="noreferrer">
            {reader.sourceUrl}
          </BoardUrl>
          <Companies>
            {reader.companies.map((c) => c.name).join(", ") || "no companies"}
          </Companies>
        </div>
        <Pill $state={state}>{state}</Pill>
      </CardTop>

      <Stats>
        <Stat>
          <Label>learned by</Label>
          <Value>{reader.origin.toLowerCase()}</Value>
        </Stat>
        <Stat>
          <Label>last run</Label>
          <Value>
            {reader.lastRunAt ? relativeTime(new Date(reader.lastRunAt)) : "—"}
          </Value>
        </Stat>
        <Stat>
          <Label>jobs</Label>
          <Value>{reader.jobsLastRun ?? "—"}</Value>
        </Stat>
        <Stat>
          <Label>missing, not delisted</Label>
          <Value>{reader.missingLastRun ?? "—"}</Value>
        </Stat>
        <Stat>
          <Label>overlap</Label>
          <Value>
            {reader.overlapLastRun == null
              ? "—"
              : `${Math.round(reader.overlapLastRun * 100)}%`}
          </Value>
        </Stat>
        <Stat>
          <Label>failures</Label>
          <Value>{reader.consecutiveFailures}</Value>
        </Stat>
      </Stats>

      {reader.reconNote && <Note>{reader.reconNote}</Note>}

      {reader.recipeJson && (
        <>
          <Toggle onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "show"} recipe
          </Toggle>
          {open && <Recipe>{reader.recipeJson}</Recipe>}
        </>
      )}
    </Card>
  );
}

function groupByFamily(readers: BoardReaderRow[]) {
  const byFamily = new Map<string, BoardReaderRow[]>();
  for (const r of readers) {
    const key = r.familyKey ?? "(unclassified)";
    const list = byFamily.get(key);
    if (list) list.push(r);
    else byFamily.set(key, [r]);
  }
  return [...byFamily.entries()]
    .map(([family, rows]) => ({
      family,
      rows,
      companyCount: rows.reduce((n, r) => n + r.companies.length, 0),
    }))
    .sort((a, b) => b.companyCount - a.companyCount);
}

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
  gap: ${({ theme }) => theme.space.md};
  margin-bottom: ${({ theme }) => theme.space.xl};
`;

const H1 = styled.h1`
  font-size: 22px;
  font-weight: 600;
  margin: 0;
`;

const Sub = styled.p`
  margin: ${({ theme }) => theme.space.xs} 0 0;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const BackLink = styled(Link)`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  white-space: nowrap;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const Empty = styled.p`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`;

const Group = styled.section`
  margin-bottom: ${({ theme }) => theme.space.xl};
`;

const GroupHeader = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const GroupName = styled.h2`
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  font-family: ${({ theme }) => theme.font.mono};
`;

const GroupMeta = styled.span`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Card = styled.div`
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.md};
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const CardTop = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  min-width: 0;
`;

const BoardUrl = styled.a`
  display: block;
  font-size: 13px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;
  word-break: break-all;
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
  }
`;

const Companies = styled.div`
  margin-top: 2px;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Pill = styled.span<{ $state: string }>`
  flex: none;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.onAccent};
  background: ${({ theme, $state }) =>
    $state === "readable"
      ? theme.colors.resting
      : $state === "quarantined"
        ? theme.colors.deferred
        : $state === "needs browser"
          ? theme.colors.blocked
          : theme.colors.closed};
`;

const Stats = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.md};
  margin-top: ${({ theme }) => theme.space.sm};
`;

const Stat = styled.div`
  min-width: 0;
`;

const Label = styled.div`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const Value = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
`;

const Note = styled.p`
  margin: ${({ theme }) => theme.space.sm} 0 0;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Toggle = styled.button`
  margin-top: ${({ theme }) => theme.space.sm};
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.accent};
  cursor: pointer;
  font-family: inherit;
  &:hover {
    color: ${({ theme }) => theme.colors.accentHover};
  }
`;

const Recipe = styled.pre`
  margin: ${({ theme }) => theme.space.sm} 0 0;
  padding: ${({ theme }) => theme.space.sm};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  overflow-x: auto;
`;
