import type { RoleAttrs } from "@/server/entities/jobs/roleAttrs";

// `Partial<RoleAttrs>` is the canonical promoted-attribute list (location /
// department / compensation / employmentType — see entities/jobs/roleAttrs.ts),
// optional here because a source supplies them only when it has them: ATS APIs
// do, a generic HTML/LLM scrape may or may not. They surface to the agent in the
// pre-scan so it can filter on title + location + comp before pulling rawContent.
export type ScrapedJob = Partial<RoleAttrs> & {
  title: string;
  sourceUrl: string;
  rawContent: string;
  // The RAW provider job object (minus description blobs) — see rawAttrs() in
  // ats/shared.ts. Deliberately uncurated so a new/drifted ATS can't silently drop a
  // field; the promoted attributes above are the cleaned view on top, and
  // overlap is intentional. Persists to Job.attributes (Json); rendered for the
  // agents by attributePairs(). Nested values are kept as-is. Omit when empty.
  attributes?: Record<string, unknown>;
};

export type AtsProvider =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "teamtailor"
  | "gem"
  | "amazon"
  | "smartrecruiters"
  | "workable"
  | "eightfold"
  | "rippling"
  | "oracle"
  | "apple"
  | "jazzhr"
  | "icims"
  | "shopify"
  | "meta"
  | "netflix"
  | "google";

export type ScrapeDiagnostics = {
  provider: AtsProvider | "generic-html";
  fetchedUrl: string;
  pageLength: number;
  pageSnippet: string;
  scriptTagCount?: number;
  // Set when `jobs` is NOT a complete snapshot of the board — either the
  // provider's cap bit, or a detail fetch dropped a row. Value = how many jobs
  // came back. The two causes are deliberately conflated: a dropped row is
  // absent from the list exactly like a capped one, and both are indenting the
  // same lie ("the board holds only these").
  //
  // Load-bearing beyond display: closure detection SKIPS a scrape carrying
  // this, because the postings it never fetched would otherwise read as taken
  // down and get delisted for every user (see detectAndApplyClosures).
  truncatedAt?: number;
};

export type ScrapedCompany = {
  companyName: string;
  jobs: ScrapedJob[];
  diagnostics?: ScrapeDiagnostics;
};

export type ScrapeResult =
  { ok: true; data: ScrapedCompany } | { ok: false; error: string };

// Application form questions scraped from the ATS. Stored on
// Job.applicationQuestions; null = no fetch attempted yet, which is distinct
// from {status:"empty"} (fetched, no questions on the form).
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

// HIGH-CONFIDENCE "definitely a prose answer" short-circuit — NOT the
// authoritative draft-vs-skip classifier. Across the supported ATSes the
// long-form / free-text widget surfaces as:
//   Greenhouse / Lever / Teamtailor → "textarea"
//   Ashby                           → "LongText"
//   Workday                         → "Long Text"  (provider descriptor, passthrough)
//   Gem                             → "LONG_TEXT"  (provider answerType, passthrough)
//   Workable                        → "paragraph"  (provider field type, passthrough)
// Match is case- and separator-insensitive so the passthrough provider strings
// ("Long Text", "LONG_TEXT") all normalize together.
//
// Intentionally HIGH PRECISION, LOW RECALL: some genuinely prose questions
// render as a single-line `text` input (Greenhouse form authors do this often),
// and those will NOT match here — so a non-match means "unknown", not "not
// prose". Nothing decides a verdict from this: applicationDeciderSubAgent reads
// the question text and calls it. This only supplies the deterministic fallback
// when that call is unavailable (a malformed emission, or drafting invoked with
// no decision on file).
//
// MAINTENANCE: when adding a new ATS, add its long-text type string here and its
// definitely-skip types to STOCK_FIELD_TYPES below. Mirrored in
// docs/ats-scrapers.md → "Adding a new ATS".
export function isProseQuestion(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase().replace(/[\s_-]+/g, "");
  return (
    normalized === "textarea" ||
    normalized === "longtext" ||
    normalized === "paragraph"
  );
}

// The mirror NEGATIVE short-circuit: types that are definitely structured /
// stock fields — never worth an LLM-drafted prose answer (the user picks an
// option, ticks a box, uploads a file, or pastes a known value). Normalized
// (case- and separator-insensitive) so provider variants collapse:
//   Greenhouse:  select / multi_select / single_select / checkbox
//   Lever:       dropdown / multiple-choice / multiple-select / file-upload
//   Ashby:       Boolean / ValueSelect / MultiValueSelect / Phone / File
//   Workday:     "Multiple Choice - Single Select" / "Checkbox" / etc.
//   Gem:         SINGLE_SELECT / MULTI_SELECT / etc.
// Unlike isProseQuestion this one IS authoritative: a matching field is skipped
// before the decider sees it (decideApplicationForm's partition), because a
// dropdown or a checkbox has no prose answer by construction. Keep the list
// current as new ATSes land (see docs/ats-scrapers.md → "Adding a new ATS") — a
// missing type string costs tokens on a field with nothing to write.
const STOCK_FIELD_TYPES = new Set([
  "select",
  "dropdown",
  "checkbox",
  "boolean",
  "singleselect",
  "multiselect",
  "multipleselect",
  "multiplechoice",
  "multiplechoicesingleselect",
  "valueselect",
  "multivalueselect",
  "phone",
  // NOTE: file / file-upload / attachment are deliberately NOT here. A file
  // field is ambiguous — a resume/transcript upload is skip, but a "Cover
  // Letter" / "Writing sample" / "Personal statement" upload wants prose the
  // user must compose. So file questions go to the decider to judge by their
  // label, never blanket-skipped (a blanket skip dropped an Ashby "Cover Letter"
  // File field entirely). See isCoverLetterQuestion + the decider's file guidance.
]);

export function isStockFieldType(type: string | undefined): boolean {
  if (!type) return false;
  return STOCK_FIELD_TYPES.has(type.toLowerCase().replace(/[\s_-]+/g, ""));
}

// A form question that IS a cover letter (whatever its widget type). Greenhouse
// exposes the cover letter as a separate attachment flag (envelope.coverLetter),
// but other ATSes (Ashby, etc.) render it as a form question — often a File
// upload literally labeled "Cover Letter". This routes such a question to the
// cover-letter path (draft/co-write into JobInteraction.coverLetter) instead of
// treating it as a generic short answer. Name-match is a routing convenience,
// not a gate: a cover letter the regex misses still reaches the decider as a
// normal question (file fields are no longer auto-skipped), so it's not dropped.
export function isCoverLetterQuestion(question: string | undefined): boolean {
  if (!question) return false;
  return /\bcover\s*letter\b/i.test(question);
}
