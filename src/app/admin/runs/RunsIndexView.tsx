"use client";

import Link from "next/link";
import styled from "styled-components";

import { shortDateTime } from "@/utils/date";
import { money } from "@/utils/format";

import type { RunsIndexData, RunSummary } from "./types";

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xxl};
  font-family: ${({ theme }) => theme.font.body};
`;
const Container = styled.div`
  max-width: 1100px;
  margin: 0 auto;
`;
const Header = styled.header`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: ${({ theme }) => theme.space.lg};
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
const FilterBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.sm};
  align-items: center;
  margin-bottom: ${({ theme }) => theme.space.md};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;
const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgPanel};
`;
const ClearLink = styled(Link)`
  color: ${({ theme }) => theme.colors.accent};
  text-decoration: none;
`;
const Scroll = styled.div`
  overflow-x: auto;
`;
const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
`;
const Th = styled.th`
  text-align: left;
  padding: ${({ theme }) => theme.space.sm};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
  font-weight: 500;
  white-space: nowrap;
`;
const Td = styled.td`
  padding: ${({ theme }) => theme.space.sm};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  vertical-align: top;
`;
const Row = styled.tr`
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;
const Mono = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
`;
const FlowPill = styled.span`
  display: inline-block;
  padding: 1px 7px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  font-size: 11px;
`;
const Stopped = styled.span`
  color: ${({ theme }) => theme.colors.danger};
  font-size: 11px;
`;
const LegacyTag = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;
const ViewLink = styled(Link)`
  color: ${({ theme }) => theme.colors.accent};
  text-decoration: none;
  white-space: nowrap;
  &:hover {
    text-decoration: underline;
  }
`;
const Empty = styled.div`
  padding: ${({ theme }) => theme.space.xl};
  text-align: center;
  color: ${({ theme }) => theme.colors.textMuted};
`;
const Pager = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: ${({ theme }) => theme.space.md};
  font-size: 13px;
`;
const PageBtn = styled(Link)`
  padding: 4px 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;
const PageBtnDisabled = styled.span`
  padding: 4px 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  opacity: 0.5;
`;
const PageInfo = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`;

function runHref(r: RunSummary): string {
  return `/admin/runs/${encodeURIComponent(r.runId)}`;
}

// Build a /admin/runs URL for a given page, preserving active filters.
function pageHref(filter: RunsIndexData["filter"], page: number): string {
  const q = new URLSearchParams();
  if (filter.user) q.set("user", filter.user);
  if (filter.session) q.set("session", filter.session);
  if (filter.run) q.set("run", filter.run);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/admin/runs?${s}` : "/admin/runs";
}

export function RunsIndexView({ data }: { data: RunsIndexData }) {
  const { runs, filter } = data;
  const hasFilter = !!(filter.user || filter.session || filter.run);

  return (
    <Page>
      <Container>
        <Header>
          <H1>Runs</H1>
          <BackLink href="/admin">← Admin</BackLink>
        </Header>

        {hasFilter && (
          <FilterBar>
            <span>Filtered:</span>
            {filter.user && <Chip>user {filter.user.slice(0, 10)}…</Chip>}
            {filter.session && (
              <Chip>session {filter.session.slice(0, 10)}…</Chip>
            )}
            {filter.run && <Chip>run {filter.run.slice(0, 10)}…</Chip>}
            <ClearLink href="/admin/runs">clear</ClearLink>
          </FilterBar>
        )}

        {runs.length === 0 ? (
          <Empty>
            No runs captured yet. New chat activity (after the run-tree
            migration + a dev restart) will appear here.
          </Empty>
        ) : (
          <Scroll>
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>User</Th>
                  <Th>Flow</Th>
                  <Th>Turns</Th>
                  <Th>Cost</Th>
                  <Th>Session</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <Row key={r.runId}>
                    <Td>
                      {shortDateTime(r.createdAt)}
                      {r.stopped && (
                        <>
                          {" "}
                          · <Stopped>interrupted</Stopped>
                        </>
                      )}
                    </Td>
                    <Td>{r.userEmail ?? <Mono>{r.userId ?? "—"}</Mono>}</Td>
                    <Td>
                      {r.legacy ? (
                        <LegacyTag>pre-capture</LegacyTag>
                      ) : r.flow ? (
                        <FlowPill>{r.flow}</FlowPill>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>{r.legacy ? "—" : r.turnCount}</Td>
                    <Td>{r.legacy ? "—" : money(r.cost)}</Td>
                    <Td>
                      <Link href={`/admin/session/${r.sessionId}`}>
                        <Mono>{r.sessionId.slice(0, 8)}…</Mono>
                      </Link>
                    </Td>
                    <Td>
                      <ViewLink href={runHref(r)}>inspect →</ViewLink>
                    </Td>
                  </Row>
                ))}
              </tbody>
            </Table>
          </Scroll>
        )}

        {(runs.length > 0 || data.page > 1) && (
          <Pager>
            {data.page > 1 ? (
              <PageBtn href={pageHref(filter, data.page - 1)}>← Prev</PageBtn>
            ) : (
              <PageBtnDisabled>← Prev</PageBtnDisabled>
            )}
            <PageInfo>
              Page {data.page}
              {" · "}
              {runs.length} run{runs.length === 1 ? "" : "s"}
            </PageInfo>
            {data.hasNext ? (
              <PageBtn href={pageHref(filter, data.page + 1)}>Next →</PageBtn>
            ) : (
              <PageBtnDisabled>Next →</PageBtnDisabled>
            )}
          </Pager>
        )}
      </Container>
    </Page>
  );
}
