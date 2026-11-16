"use client";

import styled from "styled-components";

import { withImpersonate } from "@/shared/impersonation";
import { relativeTime } from "@/shared/utils/date";
import { humanBytes } from "@/shared/utils/format";

import { CardHint, CardPad, EmptyHint } from "./styles";

import type { DocumentsPayload } from "./types";

export function AttachmentsBody({
  attachments,
  impersonate,
}: {
  attachments: DocumentsPayload["attachments"];
  impersonate: string | null;
}) {
  if (attachments.length === 0) {
    return (
      <CardPad>
        <EmptyHint>No files uploaded in chat yet.</EmptyHint>
      </CardPad>
    );
  }
  return (
    <CardPad>
      <CardHint>
        Files you dropped into chat. Download to grab your originals.
      </CardHint>
      {attachments.map((f) => (
        <FileRow key={f.id}>
          <FileName>
            {f.fileName}
            <FileMeta>
              {humanBytes(f.fileSize)} · {relativeTime(f.createdAt)}
            </FileMeta>
          </FileName>
          <DownloadLink
            href={withImpersonate(
              `/api/documents/attachments/${f.id}`,
              impersonate,
            )}
            download={f.fileName}
          >
            Download
          </DownloadLink>
        </FileRow>
      ))}
    </CardPad>
  );
}

const FileRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} 0`};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  &:last-child {
    border-bottom: none;
  }
`;

const FileName = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  word-break: break-word;
`;

const FileMeta = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  margin-left: ${({ theme }) => theme.space.sm};
`;

const DownloadLink = styled.a`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  text-decoration: none;
  flex-shrink: 0;
  &:hover {
    text-decoration: underline;
  }
`;
