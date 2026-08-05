// One-line "what this sub-agent is supposed to do" per operation, used to frame
// the auditor's judgement. Kept terse and user-neutral (no internal file
// paths). Sourced from the UsageOperation comments in src/server/platform/usage/track.ts
// and docs/sub-agents.md. Operations absent here (e.g. whats_next, eval_fit if
// they appear) fall back to a generic note and are treated as zero-coverage.

export const OPERATION_PURPOSE: Record<string, string> = {
  name_extraction:
    "Extract the company name(s) the user wants to track from their free-form message. Must not invent names or grab conversational noise.",
  scan_job:
    "Give a per-job match/skip verdict for one posting against the user's thesis + profile, with a close reason on skip. Thesis-coherent, not keyword-matched.",
  profile_enrichment_check:
    "Decide whether the user's profile is enriched enough to leave profile-building, and if not, which slots are still missing. Correct ok/notOk + honest missing-slot labels.",
  enrich_job:
    "Turn a raw job posting into a terse, faithful summary + cleaned scalar attributes. Lossless — never guess fields the posting doesn't state.",
  logo_verifier:
    "Vision-verify whether a candidate favicon/logo actually belongs to the company: correct / wrong / uncertain (+ a better URL when wrong).",
  compact_summary:
    "Summarize an about-to-be-truncated transcript, capturing context that would otherwise be lost without restating durable state already in memory.",
  company_suggestions:
    "Suggest additional companies to watch that match the user's direction, without duplicating the existing watchlist or padding the roster.",
  shortlist_reject_summary:
    "After the user rejects shortlist picks, synthesize grounded per-job skip notes + decide whether any of it warrants a memory write.",
  parse_resume:
    "Parse an uploaded resume (PDF/text) into structured fields, faithfully — no embellishment, no invented experience, no contact-info leakage.",
  memory_consolidation:
    "At compaction, write durable multi-path memory updates from the transcript (profile.md, companies/{slug}.md, …). Specific + warranted, no trivial writes.",
  application_drafting:
    "Draft a cover letter / short answers grounded in the actual application form + the user's resume and reuse material — in the user's voice, no fabrication.",
  application_decider:
    "Route each application-form question to draft / skip / ask_user and produce a cover letter. Adjacency isn't support; a fill-in fact is skip even when the material has it; reuse a prior answer over re-asking.",
  shortlist_jobs:
    "Relatively rank a company's scanned roles and pick the ones worth shortlisting. Honor seniority/track, hard vetoes, and never fabricate fit.",
  pre_scan_job_batch:
    "Bulk-bucket a company's postings on metadata alone (location, domain, role type) before the expensive scan. Don't over-skip plausible roles.",
  discovery_search:
    "Web-search for companies matching the user's direction, deduped and inside the stated stage band. Direction-match, not generic name-dropping.",
  company_basic_info:
    "Web-search to rediscover a company's canonical careers/ATS URL + name + a rich description for the watchlist-add / fetch-jobs-for-company paths.",
};
