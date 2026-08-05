"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import styled from "styled-components";

export type AdminNoteRow = {
  id: string;
  category: string;
  severity: string;
  summary: string;
  context: string | null;
  sessionId: string;
  messageId: string | null;
  dedupKey: string | null;
  occurrenceCount: number;
  createdAt: string;
  lastSeenAt: string;
  dismissed: boolean;
  userId: string;
  userLabel: string;
};

const ALL_USERS = "__all__";

type Props = {
  open: AdminNoteRow[];
  recentlyDismissed: AdminNoteRow[];
};

const CATEGORY_LABEL: Record<string, string> = {
  user_confusion: "User confusion",
  agent_confusion: "Agent confusion",
  flow_friction: "Flow friction",
  capability_request: "Capability requests",
  tool_misbehavior: "Tool misbehavior",
  self_improvement: "Self-improvement",
  // Browser-side failures fanned out from ClientEvent rows.
  client_error: "Client / browser errors",
};

// Display order for the category groupings. tool_misbehavior + client_error +
// user_confusion are typically the most actionable triage targets so they
// float to the top.
const CATEGORY_ORDER = [
  "tool_misbehavior",
  "client_error",
  "user_confusion",
  "agent_confusion",
  "flow_friction",
  "capability_request",
  "self_improvement",
];

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

const GroupTitle = styled.h3`
  font-size: 13px;
  font-weight: 600;
  margin: ${({ theme }) => `${theme.space.lg} 0 ${theme.space.sm}`};
  color: ${({ theme }) => theme.colors.text};
`;

const Empty = styled.div`
  font-size: 13px;
  font-style: italic;
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: ${({ theme }) => theme.space.md};
  border: 1px dashed ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
`;

const Card = styled.div<{ $dismissed?: boolean }>`
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  margin-bottom: ${({ theme }) => theme.space.sm};
  opacity: ${({ $dismissed }) => ($dismissed ? 0.55 : 1)};
`;

const Body = styled.div`
  min-width: 0;
`;

const SummaryRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  flex-wrap: wrap;
`;

const Summary = styled.div`
  font-size: 14px;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.4;
`;

// Severity badges use the existing palette accents — no new colors needed.
// HIGH = warn (already an "attention" color in the theme), MEDIUM = textMuted-shaped,
// LOW = textSubtle-shaped. Background is a faint tint of the same.
const SeverityBadge = styled.span<{ $sev: string }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  text-transform: uppercase;
  letter-spacing: 0.6px;
  padding: 2px 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid
    ${({ theme, $sev }) =>
      $sev === "HIGH"
        ? theme.colors.danger
        : $sev === "LOW"
          ? theme.colors.border
          : theme.colors.borderStrong};
  color: ${({ theme, $sev }) =>
    $sev === "HIGH"
      ? theme.colors.danger
      : $sev === "LOW"
        ? theme.colors.textSubtle
        : theme.colors.textMuted};
`;

const OccurrenceChip = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 5px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Context = styled.div`
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
  flex-wrap: wrap;
`;

const SessionTag = styled(Link)`
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
`;

const UserTag = styled.span`
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bg};
  padding: 1px 5px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
`;

const FilterRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: ${({ theme }) => theme.space.md};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const FilterSelect = styled.select`
  font-size: 13px;
  font-family: ${({ theme }) => theme.font.body};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  background: ${({ theme }) => theme.colors.bgPanel};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
`;

const DedupKey = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  background: ${({ theme }) => theme.colors.bg};
  padding: 1px 4px;
  border-radius: ${({ theme }) => theme.radius.sm};
`;

// Click-to-copy id chip: shows a short suffix (matches the `session …` style),
// copies the FULL id on click, and flips to a ✓ briefly for feedback. Used for
// both the anchor messageId and the AdminNote's own id.
const CopyChip = styled.button`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: 1px 5px;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

function CopyId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <CopyChip
      type="button"
      title={`Copy ${label} id: ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      {label} {value.slice(-8)}
      {copied ? " ✓" : ""}
    </CopyChip>
  );
}

const Actions = styled.div`
  display: flex;
  align-items: flex-start;
`;

const DismissButton = styled.button`
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

function NoteCard({
  note,
  onDismiss,
  pending,
}: {
  note: AdminNoteRow;
  onDismiss?: (id: string) => void;
  pending: boolean;
}) {
  const showLastSeen = note.lastSeenAt && note.lastSeenAt !== note.createdAt;
  return (
    <Card $dismissed={note.dismissed}>
      <Body>
        <SummaryRow>
          <SeverityBadge $sev={note.severity}>{note.severity}</SeverityBadge>
          {note.occurrenceCount > 1 && (
            <OccurrenceChip>×{note.occurrenceCount}</OccurrenceChip>
          )}
          <Summary>{note.summary}</Summary>
        </SummaryRow>
        {note.context && <Context>{note.context}</Context>}
        <Meta>
          <UserTag>{note.userLabel}</UserTag>
          <span>·</span>
          <span>first {new Date(note.createdAt).toLocaleString()}</span>
          {showLastSeen && (
            <>
              <span>·</span>
              <span>last {new Date(note.lastSeenAt).toLocaleString()}</span>
            </>
          )}
          <span>·</span>
          <SessionTag href={`/admin/session/${note.sessionId}`}>
            session {note.sessionId.slice(-8)}
          </SessionTag>
          {note.dedupKey && (
            <>
              <span>·</span>
              <DedupKey>{note.dedupKey}</DedupKey>
            </>
          )}
          <span>·</span>
          {note.messageId ? (
            <CopyId label="msg" value={note.messageId} />
          ) : (
            <span>msg —</span>
          )}
          <CopyId label="note" value={note.id} />
        </Meta>
      </Body>
      <Actions>
        {!note.dismissed && onDismiss && (
          <DismissButton onClick={() => onDismiss(note.id)} disabled={pending}>
            Dismiss
          </DismissButton>
        )}
      </Actions>
    </Card>
  );
}

export function AdminNotesView({ open, recentlyDismissed }: Props) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [selectedUserId, setSelectedUserId] = useState<string>(ALL_USERS);
  const [, startTransition] = useTransition();

  // Build the user options from both lists so a user with only dismissed notes
  // still appears in the filter.
  const userOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of [...open, ...recentlyDismissed]) {
      if (!seen.has(n.userId)) seen.set(n.userId, n.userLabel);
    }
    return Array.from(seen.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [open, recentlyDismissed]);

  const matchesUser = (n: AdminNoteRow) =>
    selectedUserId === ALL_USERS || n.userId === selectedUserId;

  const visibleOpen = useMemo(
    () => open.filter((n) => !dismissedIds.has(n.id) && matchesUser(n)),
    // matchesUser depends on selectedUserId; eslint can't see through it
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, dismissedIds, selectedUserId],
  );

  const visibleDismissed = useMemo(
    () => recentlyDismissed.filter(matchesUser),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recentlyDismissed, selectedUserId],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, AdminNoteRow[]>();
    for (const n of visibleOpen) {
      const arr = map.get(n.category) ?? [];
      arr.push(n);
      map.set(n.category, arr);
    }
    // Sort groups by CATEGORY_ORDER; unknown categories sort to the end
    // alphabetically (defensive for future categories we add later).
    const sortedEntries = Array.from(map.entries()).sort(([a], [b]) => {
      const idxA = CATEGORY_ORDER.indexOf(a);
      const idxB = CATEGORY_ORDER.indexOf(b);
      if (idxA === -1 && idxB === -1) return a.localeCompare(b);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
    return sortedEntries;
  }, [visibleOpen]);

  async function handleDismiss(id: string) {
    setPendingIds((s) => {
      const next = new Set(s);
      next.add(id);
      return next;
    });
    try {
      await fetch(`/api/admin/notes/${id}/dismiss`, { method: "POST" });
      startTransition(() => {
        setDismissedIds((s) => {
          const next = new Set(s);
          next.add(id);
          return next;
        });
      });
    } finally {
      setPendingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <Page>
      <Container>
        <Header>
          <H1>Admin notes</H1>
          <BackLink href="/">← Back to Hank</BackLink>
        </Header>

        {userOptions.length > 1 && (
          <FilterRow>
            <span>User:</span>
            <FilterSelect
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              <option value={ALL_USERS}>All users</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </FilterSelect>
          </FilterRow>
        )}

        <Section>
          <SectionTitle>Open ({visibleOpen.length})</SectionTitle>
          {visibleOpen.length === 0 ? (
            <Empty>
              No open notes. Hank hasn&apos;t flagged anything since the last
              sweep.
            </Empty>
          ) : (
            grouped.map(([category, notes]) => (
              <div key={category}>
                <GroupTitle>{CATEGORY_LABEL[category] ?? category}</GroupTitle>
                {notes.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    onDismiss={handleDismiss}
                    pending={pendingIds.has(n.id)}
                  />
                ))}
              </div>
            ))
          )}
        </Section>

        {visibleDismissed.length > 0 && (
          <Section>
            <SectionTitle>Recently dismissed</SectionTitle>
            {visibleDismissed.map((n) => (
              <NoteCard key={n.id} note={n} pending={false} />
            ))}
          </Section>
        )}
      </Container>
    </Page>
  );
}
