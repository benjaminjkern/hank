"use client";

import { useEffect, useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/client/chatStore";
import { withImpersonate } from "@/shared/impersonation";
import type { DocumentArtifact } from "@/shared/views/documents";
import type { FocusedJobView } from "@/shared/views/getFocusedJob";

import { ArtifactsBody } from "./ArtifactsBody";
import { AttachmentsBody } from "./AttachmentsBody";
import { DocumentsIndex } from "./DocumentsIndex";
import { InlineEditableDoc } from "./InlineEditableDoc";
import { ResumeBody } from "./ResumeBody";
import { CardPad } from "./styles";
import { SubPageShell } from "./SubPageShell";

import type { DocumentsPayload } from "./types";

export function DocumentsView() {
  const impersonate = useChatStore((s) => s.impersonateSessionId);
  const subPage = useChatStore((s) => s.documentsNav.subPage);
  const expandedArtifacts = useChatStore(
    (s) => s.documentsNav.expandedArtifacts,
  );
  const setSubPage = useChatStore((s) => s.setDocumentsSubPage);
  const toggleArtifact = useChatStore((s) => s.toggleDocumentsArtifact);
  const viewApplication = useChatStore((s) => s.viewApplication);
  const documentsEpoch = useChatStore((s) => s.documentsEpoch);

  const [data, setData] = useState<DocumentsPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Bumped to re-run the fetch below — the resume page asks for it after an
  // upload or a removal.
  const [reloadCount, setReloadCount] = useState(0);
  const reload = () => setReloadCount((n) => n + 1);

  // Re-runs on `documentsEpoch`, which the store bumps whenever a tool changed
  // viewed state — this page is the one panel mode with nothing in the store
  // for `refreshViewedEntities` to refetch on its behalf, so without the epoch
  // an agent-side change (a resume attached, an answer drafted) stayed
  // invisible until the user navigated away and back.
  useEffect(() => {
    let cancelled = false;
    fetch(withImpersonate("/api/documents", impersonate))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: DocumentsPayload) => {
        if (!cancelled) {
          setData(d);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [impersonate, documentsEpoch, reloadCount]);

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
          onReload={reload}
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
        hint="Everything written for an application, and which pieces Hank may draw on when he drafts the next one. The text itself belongs to the job it was written for — open that application to change it."
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

  return <DocumentsIndex data={data} onOpenPage={setSubPage} />;
}

const Empty = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-size: 14px;
  text-align: center;
`;
