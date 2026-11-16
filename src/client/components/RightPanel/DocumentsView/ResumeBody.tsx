"use client";

import { useRef, useState } from "react";
import styled from "styled-components";

import { withImpersonate } from "@/shared/impersonation";

import { ConfirmRemoveButton } from "../shared/applicationArtifacts";

import { InlineEditableDoc } from "./InlineEditableDoc";
import { CardHint, CardPad, InlineButton } from "./styles";

import type { DocumentsPayload, SaveTone } from "./types";

export function ResumeBody({
  resumes,
  background,
  readOnly,
  impersonate,
  onReload,
  onBackgroundSaved,
}: {
  resumes: DocumentsPayload["resumes"];
  background: string;
  readOnly: boolean;
  impersonate: string | null;
  onReload: () => void;
  onBackgroundSaved: (content: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadTone, setUploadTone] = useState<SaveTone>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function onRemoveFile(id: string) {
    setUploadError(null);
    try {
      const res = await fetch(
        `/api/documents/resume/file?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setUploadError("Couldn't remove that file.");
        return;
      }
      onReload();
    } catch {
      setUploadError("Couldn't remove that file.");
    }
  }

  async function onPick(file: File) {
    setUploadTone("saving");
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/documents/resume", {
        method: "POST",
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setUploadError(body.error ?? "Upload failed.");
        setUploadTone("error");
        return;
      }
      setUploadTone("saved");
      onReload();
      setTimeout(() => setUploadTone("idle"), 1500);
    } catch {
      setUploadError("Upload failed.");
      setUploadTone("error");
    }
  }

  return (
    <CardPad>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
          e.target.value = "";
        }}
      />

      <ReplaceRow>
        <CardHint style={{ marginBottom: 0 }}>
          One combined record of your background — this is what Hank reads to
          target roles and draft applications, not the files themselves. Every
          resume you upload gets folded into it: nothing is overwritten, and a
          job listed on two of them still appears once.
        </CardHint>
        {!readOnly && (
          <InlineButton
            onClick={() => fileRef.current?.click()}
            disabled={uploadTone === "saving"}
            style={{ flexShrink: 0 }}
          >
            {uploadTone === "saving"
              ? "Reading…"
              : resumes.length
                ? "Add another"
                : "Upload"}
          </InlineButton>
        )}
      </ReplaceRow>

      {uploadError && <ErrorNote>{uploadError}</ErrorNote>}

      <InlineEditableDoc
        doc="resume"
        value={background}
        readOnly={readOnly}
        placeholder={
          resumes.length
            ? "Your background will appear here once a resume is read."
            : "Upload a resume, or write your background here yourself."
        }
        onSaved={onBackgroundSaved}
      />

      {resumes.length > 0 && (
        <NotesDivider>
          <SummaryLabel>
            Uploaded {resumes.length === 1 ? "file" : "files"}
          </SummaryLabel>
          <CardHint>
            Kept so you can download the original. Removing one doesn&apos;t
            touch your background above — what it said is already folded in.
          </CardHint>
          <RowButtons>
            {resumes.map((r) => (
              <ResumeFileRow key={r.id}>
                <LinkButton
                  href={withImpersonate(
                    `/api/documents/resume/file?id=${encodeURIComponent(r.id)}`,
                    impersonate,
                  )}
                  download={r.fileName}
                >
                  {r.fileName}
                </LinkButton>
                {!readOnly && (
                  <ConfirmRemoveButton
                    // Always confirm: this row is the only copy of the file.
                    hasText
                    label="Remove"
                    prompt="Delete the file? Your merged background above won't change."
                    title={`Remove ${r.fileName}. This is the only copy of the file — the background it was folded into stays as it is.`}
                    onRemove={() => void onRemoveFile(r.id)}
                  />
                )}
              </ResumeFileRow>
            ))}
          </RowButtons>
        </NotesDivider>
      )}
    </CardPad>
  );
}

const ErrorNote = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.danger};
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const ReplaceRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: ${({ theme }) => theme.space.md};
`;

const NotesDivider = styled.div`
  margin-top: ${({ theme }) => theme.space.lg};
  padding-top: ${({ theme }) => theme.space.lg};
  border-top: 1px dashed ${({ theme }) => theme.colors.border};
`;

const SummaryLabel = styled.div`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 4px;
`;

const RowButtons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.sm};
  margin-top: ${({ theme }) => theme.space.md};
`;

// One stored resume: the download chip, plus the remove control tucked against
// it so a list of files reads as files rather than as a row of buttons.
const ResumeFileRow = styled.div`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  min-width: 0;
`;

const LinkButton = styled.a`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  text-decoration: none;
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;
