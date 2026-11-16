"use client";

import type { FocusedJobView } from "@/server/agent/tools/lib/types";
import type { DocumentArtifact } from "@/server/views/documents";

import { JobArtifactBlock } from "./JobArtifactBlock";
import { EmptyHint } from "./styles";

// Cover letters & short answers: one collapsible block per job.
export function ArtifactsBody({
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
        Everything written for an application collects here. Switch a piece on
        and Hank can draw on it when he drafts the next one; leave it off and it
        stays with the job it was written for.
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
