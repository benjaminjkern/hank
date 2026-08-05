"use client";

// Legacy commit-recap rendering, kept only for replaying chat history that
// contains the pre-2026-06-12 `<!--shortlist-commit:...-->` marker the old
// widget used to post after a successful commit. The interactive widget
// itself lives at src/components/Chat/widgets/registry/shortlistProposal/Widget.tsx
// and now submits via the standard `<!--widget-response:{...}-->` marker.
//
// Once pre-2026-06-12 chat rows have aged out / been compacted, this whole file
// can be deleted along with the import in ChatPanel.

import { useState } from "react";
import styled from "styled-components";
import { z } from "zod";

import { useChatStore } from "@/lib/chatStore";

type ShortlistCommitParsed = {
  companyName: string;
  approved: Array<{ id: string; title: string; hankTag: "pick" | "override" }>;
  skipped: Array<{ id: string; title: string; hankTag: "pass" | "override" }>;
  reason: string | null;
};

const MARKER_PREFIX = "<!--shortlist-commit:";
const MARKER_SUFFIX = "-->";
const HEADER_RE = /^\[Shortlist commit @ (.+)\]$/;
const ROW_RE = /^\s*-\s+(\S+)\s+"(.*)"\s+\(hank:\s+(\w+)\)\s*$/;

const CommitMarkerSchema = z.object({
  companyName: z.string(),
  approved: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      hankTag: z.enum(["pick", "override"]),
    }),
  ),
  skipped: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      hankTag: z.enum(["pass", "override"]),
    }),
  ),
  reason: z.string().nullable(),
});

export function tryParseShortlistCommit(
  text: string,
): ShortlistCommitParsed | null {
  const fromMarker = parseMarker(text);
  if (fromMarker) return fromMarker;
  return parseLegacyRegex(text);
}

function parseMarker(text: string): ShortlistCommitParsed | null {
  if (!text.startsWith(MARKER_PREFIX)) return null;
  const endIdx = text.indexOf(MARKER_SUFFIX, MARKER_PREFIX.length);
  if (endIdx < 0) return null;
  const json = text.slice(MARKER_PREFIX.length, endIdx);
  try {
    const parsed = JSON.parse(json);
    const validated = CommitMarkerSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function parseLegacyRegex(text: string): ShortlistCommitParsed | null {
  const lines = text.split("\n");
  if (lines.length < 4) return null;
  const headerMatch = HEADER_RE.exec(lines[0]);
  if (!headerMatch) return null;

  let approvedIdx = -1;
  let skippedIdx = -1;
  let reasonIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "Approved (SHORTLISTED):") approvedIdx = i;
    else if (lines[i] === "Skipped (USER_REJECTED):") skippedIdx = i;
    else if (lines[i].startsWith("Reason:")) {
      reasonIdx = i;
      break;
    }
  }
  if (approvedIdx === -1 || skippedIdx === -1 || reasonIdx === -1) return null;
  if (!(approvedIdx < skippedIdx && skippedIdx < reasonIdx)) return null;

  const approved: ShortlistCommitParsed["approved"] = [];
  for (let i = approvedIdx + 1; i < skippedIdx; i++) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) continue;
    const tag = m[3];
    if (tag === "pick" || tag === "override") {
      approved.push({ id: m[1], title: m[2], hankTag: tag });
    }
  }
  const skipped: ShortlistCommitParsed["skipped"] = [];
  for (let i = skippedIdx + 1; i < reasonIdx; i++) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) continue;
    const tag = m[3];
    if (tag === "pass" || tag === "override") {
      skipped.push({ id: m[1], title: m[2], hankTag: tag });
    }
  }

  const reasonRaw = lines[reasonIdx].slice("Reason:".length).trim();
  const reason =
    reasonRaw.length > 0 && reasonRaw !== "(none)" ? reasonRaw : null;

  return { companyName: headerMatch[1], approved, skipped, reason };
}

export function ShortlistCommitCard({
  payload,
}: {
  payload: ShortlistCommitParsed;
}) {
  const [open, setOpen] = useState(false);
  const viewJob = useChatStore((s) => s.viewJob);
  const approvedCount = payload.approved.length;
  const skippedCount = payload.skipped.length;
  const total = approvedCount + skippedCount;

  let headline: string;
  if (total === 0) {
    headline = `Shortlist @ ${payload.companyName}`;
  } else if (approvedCount === 0) {
    headline = `Rejected all ${total} at ${payload.companyName}`;
  } else if (skippedCount === 0) {
    headline = `Shortlisted all ${total} at ${payload.companyName}`;
  } else {
    headline = `Shortlisted ${approvedCount} of ${total} at ${payload.companyName}`;
  }

  const canExpand = total > 0;

  return (
    <CommitCard>
      <CommitHeader
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        aria-expanded={open}
        $expandable={canExpand}
      >
        {canExpand && (
          <CommitCaret $open={open} aria-hidden>
            ▶
          </CommitCaret>
        )}
        <CommitTitle>{headline}</CommitTitle>
      </CommitHeader>
      {open && canExpand && (
        <CommitBody>
          {payload.approved.map((j) => (
            <CommitRow key={j.id}>
              <RowMark $approved>✓</RowMark>
              <RowJobTitle
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  void viewJob(j.id);
                }}
              >
                {j.title}
              </RowJobTitle>
              <RowHankTag $variant={j.hankTag}>{j.hankTag}</RowHankTag>
            </CommitRow>
          ))}
          {payload.skipped.map((j) => (
            <CommitRow key={j.id}>
              <RowMark $approved={false}>✕</RowMark>
              <RowJobTitle
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  void viewJob(j.id);
                }}
              >
                {j.title}
              </RowJobTitle>
              <RowHankTag $variant={j.hankTag}>{j.hankTag}</RowHankTag>
            </CommitRow>
          ))}
        </CommitBody>
      )}
    </CommitCard>
  );
}

const CommitCard = styled.div`
  align-self: flex-end;
  max-width: 720px;
  width: fit-content;
  min-width: 280px;
  background: ${({ theme }) => theme.colors.bgHover};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
`;

const CommitHeader = styled.button<{ $expandable: boolean }>`
  appearance: none;
  background: transparent;
  border: 0;
  text-align: left;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  cursor: ${({ $expandable }) => ($expandable ? "pointer" : "default")};
  color: ${({ theme }) => theme.colors.text};
  font: inherit;

  &:hover {
    background: ${({ theme, $expandable }) =>
      $expandable ? theme.colors.bgPanel : "transparent"};
  }
`;

const CommitCaret = styled.span<{ $open: boolean }>`
  display: inline-block;
  font-size: 10px;
  color: ${({ theme }) => theme.colors.textMuted};
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.1s ease;
`;

const CommitTitle = styled.span`
  font-size: 13px;
  font-weight: 500;
  color: ${({ theme }) => theme.colors.text};
`;

const CommitBody = styled.div`
  display: flex;
  flex-direction: column;
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgPanel};
`;

const CommitRow = styled.div`
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.lg}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  &:last-child {
    border-bottom: none;
  }
`;

const RowMark = styled.span<{ $approved: boolean }>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $approved }) =>
    $approved ? theme.colors.accent : theme.colors.textSubtle};
`;

const RowJobTitle = styled.button`
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  font-size: 12px;
  font-family: inherit;
  color: ${({ theme }) => theme.colors.text};
  cursor: pointer;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
`;

const RowHankTag = styled.span<{ $variant: "pick" | "pass" | "override" }>`
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $variant }) =>
    $variant === "pick"
      ? theme.colors.accent
      : $variant === "override"
        ? theme.colors.danger
        : theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid
    ${({ theme, $variant }) =>
      $variant === "pick"
        ? theme.colors.accent
        : $variant === "override"
          ? theme.colors.danger
          : theme.colors.border};
`;
