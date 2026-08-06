"use client";

import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import { withImpersonate } from "@/lib/impersonation";
import { documentsSubPageLabel, type DocumentsSubPage } from "@/lib/panelMode";
import { statusColor, statusLabel } from "@/lib/statusColors";
import type { FocusedJobView } from "@/server/agent/tools/lib/types";
import type { EditableDocKind } from "@/server/entities/narrativeDocs";
import type { DocumentArtifact, UserDocuments } from "@/server/views/documents";
import { relativeTime } from "@/utils/date";
import { humanBytes } from "@/utils/format";

import {
  ReuseSwitch,
  ConfirmRemoveButton,
  buildShortAnswersReuse,
  effectiveReuse,
  patchJobInteraction,
} from "./shared/applicationArtifacts";

type DocumentsPayload = UserDocuments & { readOnly: boolean };

// ---- layout -----------------------------------------------------------------

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
`;

const PageHead = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
  margin-bottom: ${({ theme }) => theme.space.xs};
`;

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

// ---- index (navigable cards) ------------------------------------------------

// The Documents view opens on an index: one card per document, each a button
// that navigates to its own sub-page. Keeps the landing short — just titles,
// a one-line description, and a filled/empty indicator — instead of a long
// scroll of every doc's body.
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

// ---- sub-page chrome --------------------------------------------------------

const SubTitle = styled.h3`
  font-size: 15px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: ${({ theme }) => `${theme.space.xs} 0 0 0`};
`;

const SubHint = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
  margin-top: 2px;
`;

// Getting back up to the index is the breadcrumb's job (`Dashboard /
// Documents / <this page>`) and the browser's — each sub-page has its own URL.
function SubPageShell({
  subPage,
  hint,
  children,
}: {
  subPage: DocumentsSubPage;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Wrap>
      <PageHead>
        <SubTitle>{documentsSubPageLabel(subPage)}</SubTitle>
        {hint && <SubHint>{hint}</SubHint>}
      </PageHead>
      {children}
    </Wrap>
  );
}

// Card body wrapper for the narrative / resume / files sub-pages.
const CardPad = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.xl}`};
`;

// ---- shared bits ------------------------------------------------------------

const CardHint = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  line-height: 1.4;
  margin-bottom: ${({ theme }) => theme.space.md};
`;

const Prose = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  white-space: pre-wrap;
  line-height: 1.55;
  word-break: break-word;
`;

const EmptyHint = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
`;

const ErrorNote = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.danger};
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const FieldHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: 4px;
  min-height: 14px;
`;

const FieldLabel = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
`;

const TextArea = styled.textarea`
  width: 100%;
  min-height: 200px;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.md};
  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const InlineButton = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
  &:disabled {
    color: ${({ theme }) => theme.colors.textSubtle};
    cursor: not-allowed;
  }
`;

const RowButtons = styled.div`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  margin-top: ${({ theme }) => theme.space.md};
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

type SaveTone = "idle" | "saving" | "saved" | "error";

const SaveNote = styled.span<{ $tone: SaveTone }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $tone }) =>
    $tone === "error"
      ? theme.colors.danger
      : $tone === "saved"
        ? theme.colors.success
        : theme.colors.textSubtle};
  opacity: ${({ $tone }) => ($tone === "idle" ? 0 : 1)};
  transition: opacity 0.2s;
`;

const Empty = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-size: 14px;
  text-align: center;
`;

// ---- helpers ----------------------------------------------------------------

function saveToneLabel(t: SaveTone): string {
  if (t === "saving") return "Saving…";
  if (t === "saved") return "Saved";
  if (t === "error") return "Save failed";
  return "";
}

// ---- editable narrative doc (edit in place, autosave on blur) ---------------

// One editable markdown doc. No view/edit mode switch — the textarea is always
// live and saves when you click away (matching the cover-letter / short-answer
// editors). `label` is rendered only for inline use (e.g. resume framing
// notes); on its own sub-page the SubTitle carries the name and no label is
// passed.
function InlineEditableDoc({
  label,
  hint,
  doc,
  value,
  readOnly,
  placeholder,
  onSaved,
}: {
  label?: string;
  hint?: string;
  doc: EditableDocKind;
  value: string;
  readOnly: boolean;
  placeholder: string;
  onSaved: (content: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  const [lastSynced, setLastSynced] = useState(value);
  const [focused, setFocused] = useState(false);
  const [tone, setTone] = useState<SaveTone>("idle");

  // Re-sync from the canonical value when it changes externally (another save,
  // an impersonation reload) and we're not mid-edit. Mirrors the artifact
  // editors' adjust-state-during-render sync.
  if (value !== lastSynced) {
    setLastSynced(value);
    if (!focused) {
      setDraft(value);
      setSavedValue(value);
    }
  }

  async function save() {
    if (draft === savedValue) return;
    setTone("saving");
    try {
      const res = await fetch("/api/documents/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, content: draft }),
      });
      if (!res.ok) throw new Error();
      setSavedValue(draft);
      onSaved(draft);
      setTone("saved");
      setTimeout(() => setTone("idle"), 1500);
    } catch {
      setTone("error");
    }
  }

  if (readOnly) {
    return (
      <div>
        {label && <FieldLabel style={{ marginBottom: 4 }}>{label}</FieldLabel>}
        {hint && <CardHint>{hint}</CardHint>}
        {value.trim() ? (
          <Prose>{value}</Prose>
        ) : (
          <EmptyHint>{placeholder}</EmptyHint>
        )}
      </div>
    );
  }

  return (
    <div>
      <FieldHead>
        {label ? <FieldLabel>{label}</FieldLabel> : <span />}
        <SaveNote $tone={tone}>{saveToneLabel(tone)}</SaveNote>
      </FieldHead>
      {hint && <CardHint>{hint}</CardHint>}
      <TextArea
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void save();
        }}
      />
    </div>
  );
}

// ---- resume -----------------------------------------------------------------

const SummaryLabel = styled.div`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 4px;
`;

const NotesDivider = styled.div`
  margin-top: ${({ theme }) => theme.space.lg};
  padding-top: ${({ theme }) => theme.space.lg};
  border-top: 1px dashed ${({ theme }) => theme.colors.border};
`;

const ReplaceRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: ${({ theme }) => theme.space.md};
`;

function ResumeBody({
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
          Your background — what Hank reads to target roles and draft
          applications. Upload a resume and everything on it is folded in;
          upload another and it adds to this rather than replacing it.
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
          <RowButtons>
            {resumes.map((r) => (
              <LinkButton
                key={r.id}
                href={withImpersonate(
                  `/api/documents/resume/file?id=${encodeURIComponent(r.id)}`,
                  impersonate,
                )}
                download={r.fileName}
              >
                {r.fileName}
              </LinkButton>
            ))}
          </RowButtons>
        </NotesDivider>
      )}
    </CardPad>
  );
}

// ---- cover letters & short answers (collapsible per-job, read-only text) ----

const StatusPill = styled.span<{ $status: string }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 1px 7px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status }) => statusColor(theme, $status)};
  white-space: nowrap;
`;

const JobBlock = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  overflow: hidden;
  & + & {
    margin-top: ${({ theme }) => theme.space.sm};
  }
`;

// Collapsed header: chevron + job title (subtitle) + company, with a status
// pill and a short "what's inside" count. Click to expand the artifacts below.
const JobHeader = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.md}`};
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  &:hover {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
`;

const Chevron = styled.span<{ $open: boolean }>`
  display: inline-block;
  font-size: 10px;
  color: ${({ theme }) => theme.colors.textSubtle};
  flex-shrink: 0;
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.15s ease;
`;

const JobHeadMain = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
`;

const JobTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  word-break: break-word;
`;

const JobCo = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const JobHeadRight = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  flex-shrink: 0;
`;

const CountMeta = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  white-space: nowrap;
`;

const JobBody = styled.div`
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.md} ${theme.space.lg}`};
`;

const OpenJobRow = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const ArtifactSub = styled.div`
  margin-top: ${({ theme }) => theme.space.md};
  padding-top: ${({ theme }) => theme.space.md};
  border-top: 1px dashed ${({ theme }) => theme.colors.border};
  &:first-of-type {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }
`;

const SubHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: ${({ theme }) => theme.space.xs};
`;

const SubLabel = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  min-width: 0;
`;

const SubQuestion = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  word-break: break-word;
`;

const SubControls = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  flex-shrink: 0;
`;

function artifactCountMeta(a: DocumentArtifact): string {
  const parts: string[] = [];
  if (a.coverLetter !== null && a.coverLetter.trim().length > 0)
    parts.push("Cover letter");
  const n = a.shortAnswers?.length ?? 0;
  if (n > 0) parts.push(`${n} answer${n === 1 ? "" : "s"}`);
  return parts.join(" · ") || "—";
}

// One job's drafted artifacts, collapsible. The text is read-only here — this
// page is for browsing across jobs; writing happens on the application page
// (Open application →), which has room for it. The interactive controls here are
// the per-artifact "use when drafting" switch and a remove button (with an
// are-you-sure guard when there's text to lose).
function JobArtifactBlock({
  artifact,
  readOnly,
  expanded,
  onToggle,
  onOpenApplication,
  onCanonical,
  onOptimistic,
}: {
  artifact: DocumentArtifact;
  readOnly: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenApplication: () => void;
  onCanonical: (jobId: string, fresh: FocusedJobView) => void;
  onOptimistic: (jobId: string, patch: Partial<DocumentArtifact>) => void;
}) {
  async function toggleCover(next: boolean) {
    onOptimistic(artifact.jobId, { coverLetterReuse: next });
    try {
      const fresh = await patchJobInteraction(artifact.jobId, {
        coverLetterReuse: next,
      });
      if (fresh) onCanonical(artifact.jobId, fresh);
    } catch {
      /* optimistic value stays; a reload reconciles */
    }
  }

  async function toggleAnswer(i: number, next: boolean) {
    const arr = buildShortAnswersReuse(
      artifact.shortAnswersReuse,
      artifact.shortAnswers?.length ?? 0,
      i,
      next,
    );
    onOptimistic(artifact.jobId, { shortAnswersReuse: arr });
    try {
      const fresh = await patchJobInteraction(artifact.jobId, {
        shortAnswersReuse: arr,
      });
      if (fresh) onCanonical(artifact.jobId, fresh);
    } catch {
      /* optimistic value stays; a reload reconciles */
    }
  }

  async function removeCover() {
    onOptimistic(artifact.jobId, { coverLetter: null });
    try {
      const fresh = await patchJobInteraction(artifact.jobId, {
        coverLetter: null,
      });
      if (fresh) onCanonical(artifact.jobId, fresh);
    } catch {
      /* a reload reconciles */
    }
  }

  async function removeAnswer(i: number) {
    const remaining = (artifact.shortAnswers ?? []).filter((_, j) => j !== i);
    const next = remaining.length > 0 ? remaining : null;
    onOptimistic(artifact.jobId, { shortAnswers: next });
    try {
      const fresh = await patchJobInteraction(artifact.jobId, {
        shortAnswers: next,
      });
      if (fresh) onCanonical(artifact.jobId, fresh);
    } catch {
      /* a reload reconciles */
    }
  }

  const hasCover =
    artifact.coverLetter !== null && artifact.coverLetter.trim().length > 0;

  return (
    <JobBlock>
      <JobHeader type="button" onClick={onToggle} aria-expanded={expanded}>
        <Chevron $open={expanded}>▶</Chevron>
        <JobHeadMain>
          <JobTitle>{artifact.jobTitle}</JobTitle>
          <JobCo>{artifact.companyName}</JobCo>
        </JobHeadMain>
        <JobHeadRight>
          <CountMeta>{artifactCountMeta(artifact)}</CountMeta>
          <StatusPill $status={artifact.status}>
            {statusLabel(artifact.status)}
          </StatusPill>
        </JobHeadRight>
      </JobHeader>

      {expanded && (
        <JobBody>
          <OpenJobRow>
            <InlineButton onClick={onOpenApplication}>
              Open application to edit →
            </InlineButton>
          </OpenJobRow>

          {hasCover && (
            <ArtifactSub>
              <SubHead>
                <SubLabel>Cover letter</SubLabel>
                {!readOnly && (
                  <SubControls>
                    <ReuseSwitch
                      on={effectiveReuse(artifact.coverLetterReuse)}
                      onChange={(n) => void toggleCover(n)}
                    />
                    <ConfirmRemoveButton
                      hasText
                      onRemove={() => void removeCover()}
                      title="Remove cover letter"
                    />
                  </SubControls>
                )}
              </SubHead>
              <Prose>{artifact.coverLetter}</Prose>
            </ArtifactSub>
          )}

          {artifact.shortAnswers?.map((qa, i) => {
            const hasText =
              qa.question.trim().length > 0 || qa.answer.trim().length > 0;
            return (
              <ArtifactSub key={i}>
                <SubHead>
                  <SubQuestion>
                    {qa.question.trim() || `Question ${i + 1}`}
                  </SubQuestion>
                  {!readOnly && (
                    <SubControls>
                      <ReuseSwitch
                        on={effectiveReuse(artifact.shortAnswersReuse?.[i])}
                        onChange={(n) => void toggleAnswer(i, n)}
                      />
                      <ConfirmRemoveButton
                        hasText={hasText}
                        onRemove={() => void removeAnswer(i)}
                        title="Remove this answer"
                      />
                    </SubControls>
                  )}
                </SubHead>
                {qa.answer.trim() ? (
                  <Prose>{qa.answer}</Prose>
                ) : (
                  <EmptyHint>No answer yet.</EmptyHint>
                )}
              </ArtifactSub>
            );
          })}

          {!hasCover && (artifact.shortAnswers?.length ?? 0) === 0 && (
            <EmptyHint>Nothing drafted for this job yet.</EmptyHint>
          )}
        </JobBody>
      )}
    </JobBlock>
  );
}

function ArtifactsBody({
  artifacts,
  readOnly,
  expandedArtifacts,
  onToggleArtifact,
  onOpenApplication,
  onCanonical,
  onOptimistic,
}: {
  artifacts: DocumentArtifact[];
  readOnly: boolean;
  expandedArtifacts: string[];
  onToggleArtifact: (jobInteractionId: string) => void;
  onOpenApplication: (jobId: string) => void;
  onCanonical: (jobId: string, fresh: FocusedJobView) => void;
  onOptimistic: (jobId: string, patch: Partial<DocumentArtifact>) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <EmptyHint>
        Cover letters and answers you draft will show up here — expand one to
        read it or toggle whether Hank reuses it; open the job to edit its text.
      </EmptyHint>
    );
  }

  const expanded = new Set(expandedArtifacts);

  return (
    <div>
      {artifacts.map((a) => (
        <JobArtifactBlock
          key={a.jobInteractionId}
          artifact={a}
          readOnly={readOnly}
          expanded={expanded.has(a.jobInteractionId)}
          onToggle={() => onToggleArtifact(a.jobInteractionId)}
          onOpenApplication={() => onOpenApplication(a.jobId)}
          onCanonical={onCanonical}
          onOptimistic={onOptimistic}
        />
      ))}
    </div>
  );
}

// ---- attachments ------------------------------------------------------------

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

function AttachmentsBody({
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

// ---- root -------------------------------------------------------------------

export function DocumentsView() {
  const impersonate = useChatStore((s) => s.impersonateSessionId);
  const subPage = useChatStore((s) => s.documentsNav.subPage);
  const expandedArtifacts = useChatStore(
    (s) => s.documentsNav.expandedArtifacts,
  );
  const setSubPage = useChatStore((s) => s.setDocumentsSubPage);
  const toggleArtifact = useChatStore((s) => s.toggleDocumentsArtifact);
  const viewApplication = useChatStore((s) => s.viewApplication);

  const [data, setData] = useState<DocumentsPayload | null>(null);
  const [loadError, setLoadError] = useState(false);

  function load() {
    setLoadError(false);
    fetch(withImpersonate("/api/documents", impersonate))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: DocumentsPayload) => setData(d))
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    let cancelled = false;
    fetch(withImpersonate("/api/documents", impersonate))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: DocumentsPayload) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [impersonate]);

  if (loadError)
    return (
      <Empty>
        Couldn&apos;t load your documents — reopen this view to retry.
      </Empty>
    );
  if (!data) return <Empty>Loading…</Empty>;

  const { readOnly } = data;

  const setDoc = (
    key: "profile" | "frequentQuestions" | "resume",
    content: string,
  ) =>
    setData((prev) =>
      prev ? { ...prev, docs: { ...prev.docs, [key]: content } } : prev,
    );

  const onArtifactCanonical = (jobId: string, fresh: FocusedJobView) => {
    if (!fresh) return;
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        artifacts: prev.artifacts.map((a) =>
          a.jobId === jobId
            ? {
                ...a,
                status: fresh.jobInteraction.status,
                coverLetter: fresh.jobInteraction.coverLetter,
                coverLetterReuse: fresh.jobInteraction.coverLetterReuse,
                shortAnswers: fresh.jobInteraction.shortAnswers,
                shortAnswersReuse: fresh.jobInteraction.shortAnswersReuse,
              }
            : a,
        ),
      };
    });
  };

  const onArtifactOptimistic = (
    jobId: string,
    patch: Partial<DocumentArtifact>,
  ) =>
    setData((prev) =>
      prev
        ? {
            ...prev,
            artifacts: prev.artifacts.map((a) =>
              a.jobId === jobId ? { ...a, ...patch } : a,
            ),
          }
        : prev,
    );

  // ---- sub-pages ----
  if (subPage === "resume") {
    return (
      <SubPageShell subPage="resume">
        <ResumeBody
          resumes={data.resumes}
          background={data.docs.resume}
          readOnly={readOnly}
          impersonate={impersonate}
          onReload={load}
          onBackgroundSaved={(c) => setDoc("resume", c)}
        />
      </SubPageShell>
    );
  }

  if (subPage === "profile") {
    return (
      <SubPageShell
        subPage="profile"
        hint="Your target role, level, location and comp, plus the preferences Hank applies everywhere (e.g. 'always IC, never lead')."
      >
        <CardPad>
          <InlineEditableDoc
            doc="profile"
            value={data.docs.profile}
            readOnly={readOnly}
            placeholder="Hank fills this in as you chat, or write it yourself."
            onSaved={(c) => setDoc("profile", c)}
          />
        </CardPad>
      </SubPageShell>
    );
  }

  if (subPage === "frequent") {
    return (
      <SubPageShell
        subPage="frequent"
        hint="Saved answers to recurring application questions Hank reuses when drafting."
      >
        <CardPad>
          <InlineEditableDoc
            doc="frequent_questions"
            value={data.docs.frequentQuestions}
            readOnly={readOnly}
            placeholder="Answers you reuse across applications get saved here."
            onSaved={(c) => setDoc("frequentQuestions", c)}
          />
        </CardPad>
      </SubPageShell>
    );
  }

  if (subPage === "artifacts") {
    return (
      <SubPageShell
        subPage="artifacts"
        hint="Drafts you've created. Expand one to read it or toggle whether Hank reuses it for new applications; open the job to edit the text."
      >
        <ArtifactsBody
          artifacts={data.artifacts}
          readOnly={readOnly}
          expandedArtifacts={expandedArtifacts}
          onToggleArtifact={toggleArtifact}
          onOpenApplication={(jobId) => void viewApplication(jobId)}
          onCanonical={onArtifactCanonical}
          onOptimistic={onArtifactOptimistic}
        />
      </SubPageShell>
    );
  }

  if (subPage === "files") {
    return (
      <SubPageShell subPage="files">
        <AttachmentsBody
          attachments={data.attachments}
          impersonate={impersonate}
        />
      </SubPageShell>
    );
  }

  // ---- index ----
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
      description: "Drafts you've created, and which ones Hank reuses.",
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
          onOpen={() => setSubPage(r.page)}
        />
      ))}
    </Wrap>
  );
}
