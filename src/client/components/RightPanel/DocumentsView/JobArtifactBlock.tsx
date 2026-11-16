"use client";

import styled from "styled-components";

import type { FocusedJobView } from "@/server/agent/tools/lib/types";
import type { DocumentArtifact } from "@/server/views/documents";
import { statusColor, statusLabel } from "@/shared/statusColors";

import {
  ReuseSwitch,
  buildShortAnswersReuse,
  effectiveReuse,
  patchJobInteraction,
} from "../shared/applicationArtifacts";

import { artifactCountMeta, reuseMeta } from "./artifactMeta";
import { EmptyHint, InlineButton, Prose } from "./styles";

// One job's drafted artifacts, collapsible. This page is a REUSE LIBRARY, not a
// second editor: its question is "which of these may Hank draw on next time",
// and the reuse switch is the only control that answers it. Text is read-only —
// a piece of writing belongs to the application it was written for, and that
// page (Open application →) is where it's changed or removed.
export function JobArtifactBlock({
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

  const hasCover =
    artifact.coverLetter !== null && artifact.coverLetter.trim().length > 0;
  const reuseLabel = reuseMeta(artifact);

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
          {reuseLabel && (
            <ReuseMeta $on={reuseLabel !== "not reused"}>
              {reuseLabel}
            </ReuseMeta>
          )}
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
                  </SubControls>
                )}
              </SubHead>
              <Prose>{artifact.coverLetter}</Prose>
            </ArtifactSub>
          )}

          {artifact.shortAnswers?.map((qa, i) => {
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

// The one thing this page decides, said on the collapsed row.
const ReuseMeta = styled(CountMeta)<{ $on: boolean }>`
  color: ${({ theme, $on }) =>
    $on ? theme.colors.accent : theme.colors.textSubtle};
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
