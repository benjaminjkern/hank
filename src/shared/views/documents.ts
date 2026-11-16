// The Documents page's payload — the editable narrative notes, every uploaded
// résumé, the drafting artifacts sitting on JobInteractions, and the raw
// attachments. Built by loadUserDocuments (server/views/documents.ts).

import type { ShortAnswer } from "@/shared/applicationDrafts";

export type DocumentArtifact = {
  jobId: string;
  jobInteractionId: string;
  companyName: string;
  jobTitle: string;
  status: string;
  coverLetter: string | null;
  coverLetterReuse: boolean | null;
  shortAnswers: ShortAnswer[] | null;
  shortAnswersReuse: (boolean | null)[] | null;
  updatedAt: string;
};

export type UserDocuments = {
  docs: {
    profile: string;
    frequentQuestions: string;
    // The user's background — the merged contents of every résumé below, plus
    // whatever they've told Hank. Editable here like any other note.
    resume: string;
  };
  // The uploaded files themselves, newest first. Several is normal: each one was
  // merged into `docs.resume`, and they stay downloadable.
  resumes: Array<{ id: string; fileName: string; uploadedAt: string }>;
  artifacts: DocumentArtifact[];
  attachments: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mediaKind: string;
    createdAt: string;
  }>;
};
