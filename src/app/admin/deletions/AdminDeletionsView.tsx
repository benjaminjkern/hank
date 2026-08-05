"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import styled from "styled-components";

import { relativeTime } from "@/utils/date";

export type DeletionRow = {
  id: string;
  kind: "company" | "job";
  title: string;
  sourceUrl: string | null;
  // For jobs, the parent company name (joined or freeform `companyName`).
  // Null for companies and for unaffiliated jobs.
  parentLabel: string | null;
  reason: string;
  recommendedAt: string;
};

type Props = {
  companies: DeletionRow[];
  jobs: DeletionRow[];
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

const Empty = styled.div`
  font-size: 13px;
  font-style: italic;
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: ${({ theme }) => theme.space.md};
  border: 1px dashed ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
`;

const Card = styled.div<{ $vanished?: boolean }>`
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  margin-bottom: ${({ theme }) => theme.space.sm};
  opacity: ${({ $vanished }) => ($vanished ? 0.4 : 1)};
`;

const Body = styled.div`
  min-width: 0;
`;

const TitleLine = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.4;
`;

const Parent = styled.span`
  font-weight: 400;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Reason = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: ${({ theme }) => theme.space.xs};
  white-space: pre-wrap;
  line-height: 1.4;
`;

const Meta = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-top: ${({ theme }) => theme.space.sm};
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  align-items: center;
`;

const SourceLink = styled.a`
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: underline;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const Actions = styled.div`
  display: flex;
  align-items: flex-start;
  gap: ${({ theme }) => theme.space.xs};
`;

const SmallButton = styled.button`
  font-size: 12px;
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  &:hover:not(:disabled) {
    color: ${({ theme }) => theme.colors.text};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const DangerButton = styled(SmallButton)`
  color: ${({ theme }) => theme.colors.danger};
  &:hover:not(:disabled) {
    color: ${({ theme }) => theme.colors.danger};
    border-color: ${({ theme }) => theme.colors.danger};
  }
`;

const ErrorBanner = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.danger};
  margin-top: ${({ theme }) => theme.space.xs};
`;

function DeletionCard({
  row,
  onDelete,
  onDismiss,
  pending,
  vanished,
  error,
}: {
  row: DeletionRow;
  onDelete: (row: DeletionRow) => void;
  onDismiss: (row: DeletionRow) => void;
  pending: boolean;
  vanished: boolean;
  error: string | null;
}) {
  return (
    <Card $vanished={vanished}>
      <Body>
        <TitleLine>
          {row.title}
          {row.parentLabel && <Parent> · {row.parentLabel}</Parent>}
        </TitleLine>
        <Reason>{row.reason}</Reason>
        <Meta>
          <span>recommended {relativeTime(row.recommendedAt)}</span>
          {row.sourceUrl && (
            <>
              <span>·</span>
              <SourceLink href={row.sourceUrl} target="_blank" rel="noreferrer">
                source
              </SourceLink>
            </>
          )}
        </Meta>
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </Body>
      <Actions>
        <SmallButton
          onClick={() => onDismiss(row)}
          disabled={pending || vanished}
        >
          Dismiss
        </SmallButton>
        <DangerButton
          onClick={() => onDelete(row)}
          disabled={pending || vanished}
        >
          Delete
        </DangerButton>
      </Actions>
    </Card>
  );
}

export function AdminDeletionsView({ companies, jobs }: Props) {
  const [vanishedIds, setVanishedIds] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  const visibleCompanies = useMemo(
    () => companies.filter((c) => !vanishedIds.has(c.id)),
    [companies, vanishedIds],
  );
  const visibleJobs = useMemo(
    () => jobs.filter((j) => !vanishedIds.has(j.id)),
    [jobs, vanishedIds],
  );

  function setPending(id: string, on: boolean) {
    setPendingIds((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function postAction(row: DeletionRow, action: "delete" | "dismiss") {
    setPending(row.id, true);
    setErrorsById((m) => {
      const rest = { ...m };
      delete rest[row.id];
      return rest;
    });
    try {
      const res = await fetch(
        `/api/admin/deletions/${row.kind}/${row.id}/${action}`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || body.ok === false) {
        setErrorsById((m) => ({
          ...m,
          [row.id]: body.error ?? `request failed (${res.status})`,
        }));
        return;
      }
      startTransition(() => {
        setVanishedIds((s) => {
          const next = new Set(s);
          next.add(row.id);
          return next;
        });
      });
    } catch (err) {
      setErrorsById((m) => ({
        ...m,
        [row.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPending(row.id, false);
    }
  }

  function handleDelete(row: DeletionRow) {
    const label = row.kind === "company" ? row.title : `the job "${row.title}"`;
    const ok = window.confirm(
      `Delete ${label} permanently?\n\nThis cascades to all interactions, events, applications and drafts. Memory notes and recruiter contacts will lose their link but survive.`,
    );
    if (!ok) return;
    void postAction(row, "delete");
  }

  function handleDismiss(row: DeletionRow) {
    void postAction(row, "dismiss");
  }

  return (
    <Page>
      <Container>
        <Header>
          <H1>Deletion recommendations</H1>
          <BackLink href="/admin">← Admin home</BackLink>
        </Header>

        <Section>
          <SectionTitle>Companies ({visibleCompanies.length})</SectionTitle>
          {visibleCompanies.length === 0 ? (
            <Empty>No companies flagged for deletion.</Empty>
          ) : (
            visibleCompanies.map((c) => (
              <DeletionCard
                key={c.id}
                row={c}
                onDelete={handleDelete}
                onDismiss={handleDismiss}
                pending={pendingIds.has(c.id)}
                vanished={vanishedIds.has(c.id)}
                error={errorsById[c.id] ?? null}
              />
            ))
          )}
        </Section>

        <Section>
          <SectionTitle>Jobs ({visibleJobs.length})</SectionTitle>
          {visibleJobs.length === 0 ? (
            <Empty>No jobs flagged for deletion.</Empty>
          ) : (
            visibleJobs.map((j) => (
              <DeletionCard
                key={j.id}
                row={j}
                onDelete={handleDelete}
                onDismiss={handleDismiss}
                pending={pendingIds.has(j.id)}
                vanished={vanishedIds.has(j.id)}
                error={errorsById[j.id] ?? null}
              />
            ))
          )}
        </Section>
      </Container>
    </Page>
  );
}
