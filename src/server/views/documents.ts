// The Documents page loader — the table-less read model behind /documents: the
// editable narrative notes, every uploaded résumé, the drafting artifacts
// sitting on JobInteractions, and the raw attachments. The payload types are
// shared/views/documents.ts; the write half (which notes are editable, and
// saving one) is entities/narrativeDocs.ts.

import { prisma } from "@/server/db/prisma";
import { readMemory } from "@/server/entities/memory/store";
import { NARRATIVE_DOC_PATHS } from "@/server/entities/narrativeDocs";
import { RESUME_PATH } from "@/server/entities/resume/store";
import type { ShortAnswer } from "@/shared/applicationDrafts";
import type { DocumentArtifact, UserDocuments } from "@/shared/views/documents";

export async function loadUserDocuments(
  userId: string,
): Promise<UserDocuments> {
  const [
    profile,
    frequentQuestions,
    resumeMd,
    resumeRows,
    jobInteractions,
    attachments,
  ] = await Promise.all([
    readMemory(userId, NARRATIVE_DOC_PATHS.profile),
    readMemory(userId, NARRATIVE_DOC_PATHS.frequent_questions),
    readMemory(userId, RESUME_PATH),
    prisma.resume.findMany({
      where: { userId },
      orderBy: { uploadedAt: "desc" },
      select: { id: true, fileName: true, uploadedAt: true },
    }),
    prisma.jobInteraction.findMany({
      where: {
        userId,
        // Coarse prefilter: a cover letter or a short-answers blob present.
        // The JSON-not-null shape mirrors loadPastDrafts (both Json? fields).
        // Empty/whitespace artifacts are dropped in the JS pass below.
        OR: [
          { coverLetter: { not: null } },
          { shortAnswers: { not: { equals: null } } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        jobId: true,
        status: true,
        updatedAt: true,
        coverLetter: true,
        coverLetterReuse: true,
        shortAnswers: true,
        shortAnswersReuse: true,
        job: {
          select: {
            title: true,
            companyName: true,
            company: { select: { name: true } },
          },
        },
      },
    }),
    prisma.attachment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        mediaKind: true,
        createdAt: true,
      },
    }),
  ]);

  const artifacts: DocumentArtifact[] = [];
  for (const i of jobInteractions) {
    const shortAnswers = (i.shortAnswers as ShortAnswer[] | null) ?? null;
    const hasCover = !!(i.coverLetter && i.coverLetter.trim().length > 0);
    const hasAnswers = !!(
      shortAnswers &&
      shortAnswers.some((a) => a.question?.trim() || a.answer?.trim())
    );
    if (!hasCover && !hasAnswers) continue;
    artifacts.push({
      jobId: i.jobId,
      jobInteractionId: i.id,
      companyName: i.job?.company?.name ?? i.job?.companyName ?? "(no company)",
      jobTitle: i.job?.title ?? "(unknown role)",
      status: i.status,
      coverLetter: hasCover ? i.coverLetter : null,
      coverLetterReuse: i.coverLetterReuse,
      shortAnswers: hasAnswers ? shortAnswers : null,
      shortAnswersReuse:
        (i.shortAnswersReuse as (boolean | null)[] | null) ?? null,
      updatedAt: i.updatedAt.toISOString(),
    });
  }

  return {
    docs: {
      profile: profile ?? "",
      frequentQuestions: frequentQuestions ?? "",
      resume: resumeMd ?? "",
    },
    resumes: resumeRows.map((r) => ({
      id: r.id,
      fileName: r.fileName,
      uploadedAt: r.uploadedAt.toISOString(),
    })),
    artifacts,
    attachments: attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      fileSize: a.fileSize,
      mediaKind: a.mediaKind,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
