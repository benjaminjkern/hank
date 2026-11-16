// The collapsed-row summaries for one job's drafted artifacts.

import type { DocumentArtifact } from "@/server/views/documents";

import { effectiveReuse } from "../shared/applicationArtifacts";

export function artifactCountMeta(a: DocumentArtifact): string {
  const parts: string[] = [];
  if (a.coverLetter !== null && a.coverLetter.trim().length > 0)
    parts.push("Cover letter");
  const n = a.shortAnswers?.length ?? 0;
  if (n > 0) parts.push(`${n} answer${n === 1 ? "" : "s"}`);
  return parts.join(" · ") || "—";
}

// How much of this job's writing is in the reuse pool — the page's actual
// question, answered on the collapsed row so it can be scanned down the list
// instead of opened one at a time.
export function reuseMeta(a: DocumentArtifact): string | null {
  let total = 0;
  let on = 0;
  if (a.coverLetter !== null && a.coverLetter.trim().length > 0) {
    total++;
    if (effectiveReuse(a.coverLetterReuse)) on++;
  }
  (a.shortAnswers ?? []).forEach((_, i) => {
    total++;
    if (effectiveReuse(a.shortAnswersReuse?.[i])) on++;
  });
  if (total === 0) return null;
  if (on === 0) return "not reused";
  return on === total ? "all reusable" : `${on}/${total} reusable`;
}
