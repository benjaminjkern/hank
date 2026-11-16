// Application form questions scraped from the ATS. Stored on
// Job.applicationQuestions; null = no fetch attempted yet, which is distinct
// from {status:"empty"} (fetched, no questions on the form).
//
// The predicates that classify a question's widget type (isStockFieldType,
// isProseQuestion, isCoverLetterQuestion) stay with the scrapers in
// server/platform/scrape/types.ts — only the shape is shared.
export type ApplicationQuestion = {
  question: string;
  required?: boolean;
  type?: string;
  // Provenance. Absent/"scraped" = pulled from the ATS. "user" = a person added
  // it by hand (the form couldn't be scraped) — UNVERIFIED, badge it as such;
  // addedByUserId/addedAt record who/when for the audit trail. Set only on the
  // merged view (loadMergedQuestions / getFocusedJob); the raw scraped envelope
  // never carries them.
  source?: "scraped" | "user";
  addedByUserId?: string;
  addedAt?: string;
  // When the adding user's chat last carried this question to Hank. Absent =
  // he hasn't been told it exists, which is what the application page's
  // pending-change chip and the panel-edit relay both key on. Cleared again on
  // a rename, since the reworded question is news too.
  relayedAt?: string;
};

// `coverLetter` on the ok/empty variants records whether the form has a
// dedicated cover-letter field (Greenhouse renders an `id="cover_letter"`
// attachment widget). true = field present, false = scraped and confirmed
// absent, undefined = the provider's fetcher doesn't detect it yet. The
// walkthrough draft step only auto-drafts a cover letter when this is true —
// many forms (incl. plenty of Greenhouse boards) don't ask for one, and
// drafting an unused cover letter for every job was a bug.
export type ApplicationQuestionsEnvelope =
  | {
      status: "ok";
      questions: ApplicationQuestion[];
      coverLetter?: boolean;
      fetchedAt: string;
    }
  | { status: "empty"; coverLetter?: boolean; fetchedAt: string }
  // `fetchedAt` is optional here only because "unsupported" rows written before
  // this field existed lack it; every new unsupported envelope is stamped
  // centrally in fetchApplicationQuestions. A missing/stale stamp lets
  // needsQuestionsRefresh retry after 24h (an ATS may gain support, or a
  // posting's apply flow may change).
  | { status: "unsupported"; fetchedAt?: string }
  | { status: "error"; error: string; fetchedAt: string };
