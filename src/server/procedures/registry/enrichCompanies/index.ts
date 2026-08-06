// The enrichCompanies procedure's public surface: work out WHO a company is —
// canonical name, description, careers/ATS URL, verified logo — for a batch of
// them, with bounded concurrency.
//
// It does not scrape, upsert jobs, prescan, or set a company status. Pulling
// roles in is a separate step that runs after a company is enriched
// (`scrape_jobs_for_company`, or the walkthrough on entry).
//
// Three ways in, one chain underneath: the `enrich_companies` tool, the
// company_checklist / company_disambiguation submissions, and the walkthrough's
// on-entry backfill. Import from `@/server/procedures/registry/enrichCompanies`
// — never a deep path, so the internal file split stays free to move.

export {
  runEnrichCompanies,
  runEnrichCompaniesCollect,
} from "./enrichCompanies";
export {
  runChecklistAdd,
  runDisambiguationResolution,
  type ChecklistAddResult,
} from "./runChecklistAdd";
export { promptAddMoreCompanies } from "./promptAddMoreCompanies";
export type {
  CompanyToEnrich,
  CompanyEnrichResult,
  EnrichCompaniesResult,
  EnrichOutcome,
  EnrichProgressEvent,
} from "./types";
