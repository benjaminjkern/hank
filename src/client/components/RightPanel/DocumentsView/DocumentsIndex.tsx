"use client";

import styled from "styled-components";

import {
  documentsSubPageLabel,
  type DocumentsSubPage,
} from "@/shared/panelMode";

import { PageHead, Wrap } from "./styles";

import type { DocumentsPayload } from "./types";

// The Documents view opens on an index: one card per document, each a button
// that navigates to its own sub-page. Keeps the landing short — just titles,
// a one-line description, and a filled/empty indicator — instead of a long
// scroll of every doc's body.
export function DocumentsIndex({
  data,
  onOpenPage,
}: {
  data: DocumentsPayload;
  onOpenPage: (page: Exclude<DocumentsSubPage, "index">) => void;
}) {
  const rows: Array<{
    page: Exclude<DocumentsSubPage, "index">;
    description: string;
    meta: string;
    filled: boolean;
  }> = [
    {
      page: "resume",
      description: "What Hank reads to target roles and draft applications.",
      meta: data.docs.resume.trim()
        ? data.resumes.length
          ? `${data.resumes.length} file${data.resumes.length === 1 ? "" : "s"}`
          : "Written in"
        : "Empty",
      filled: data.docs.resume.trim().length > 0,
    },
    {
      page: "profile",
      description:
        "Your target role, level, location and comp, plus the preferences Hank applies everywhere.",
      meta: data.docs.profile.trim() ? "Filled in" : "Empty",
      filled: data.docs.profile.trim().length > 0,
    },
    {
      page: "frequent",
      description: "Saved answers to recurring questions Hank reuses.",
      meta: data.docs.frequentQuestions.trim() ? "Filled in" : "Empty",
      filled: data.docs.frequentQuestions.trim().length > 0,
    },
    {
      page: "artifacts",
      description: "Past application writing, and which pieces Hank may reuse.",
      meta: data.artifacts.length > 0 ? `${data.artifacts.length}` : "None yet",
      filled: data.artifacts.length > 0,
    },
    {
      page: "files",
      description: "Files you dropped into chat.",
      meta: data.attachments.length > 0 ? `${data.attachments.length}` : "None",
      filled: data.attachments.length > 0,
    },
  ];

  return (
    <Wrap>
      <PageHead>
        <PageTitle>Documents</PageTitle>
        <PageHint>
          What Hank knows about you and reuses when finding jobs and drafting
          applications. Open a document to read or edit it; edits apply
          everywhere Hank works.
        </PageHint>
      </PageHead>

      {rows.map((r) => (
        <IndexRow
          key={r.page}
          title={documentsSubPageLabel(r.page)}
          description={r.description}
          meta={r.meta}
          filled={r.filled}
          onOpen={() => onOpenPage(r.page)}
        />
      ))}
    </Wrap>
  );
}

function IndexRow({
  title,
  description,
  meta,
  filled,
  onOpen,
}: {
  title: string;
  description: string;
  meta: string;
  filled: boolean;
  onOpen: () => void;
}) {
  return (
    <IndexCard type="button" onClick={onOpen}>
      <IndexMain>
        <IndexTitle>{title}</IndexTitle>
        <IndexDesc>{description}</IndexDesc>
      </IndexMain>
      <IndexMeta $filled={filled}>{meta}</IndexMeta>
      <IndexChevron aria-hidden>›</IndexChevron>
    </IndexCard>
  );
}

const PageTitle = styled.h2`
  font-size: 18px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

const PageHint = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

const IndexCard = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  cursor: pointer;
  text-align: left;
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
    background: ${({ theme }) => theme.colors.bgMuted};
  }
`;

const IndexMain = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const IndexTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const IndexDesc = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  line-height: 1.4;
`;

const IndexMeta = styled.span<{ $filled: boolean }>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $filled }) =>
    $filled ? theme.colors.textMuted : theme.colors.textSubtle};
  white-space: nowrap;
  flex-shrink: 0;
`;

const IndexChevron = styled.span`
  font-size: 16px;
  line-height: 1;
  color: ${({ theme }) => theme.colors.textSubtle};
  flex-shrink: 0;
`;
