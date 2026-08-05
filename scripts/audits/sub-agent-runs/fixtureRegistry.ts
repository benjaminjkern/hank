// Bridge from the sub-agent runtime audit to the STATIC fixtures in
// scripts/regression/sub-agents/. For each sub-agent operation, this exposes the
// scenario shapes the static suite already tests, so the runtime auditor can
// decide whether a REAL production run is covered by an existing fixture or
// represents an untested use-case shape (a coverage gap).
//
// Each audit script now `export`s its `FIXTURES` and guards its top-level run
// behind `isEntrypoint(import.meta.url)`, so importing here reads the fixtures
// without running any audit. (Importing them also loads scripts/regression/sub-agents
// /lib/judge, which sets HANK_DISABLE_SUBAGENT_CAPTURE=1 — harmless in this
// process, which reads SubAgentRun rows rather than producing them.)
//
// Operations with NO entry here (whats_next, eval_fit) have zero static
// coverage: fixturesForOperation returns null and the auditor treats every real
// run of them as a coverage gap by definition. See the README's "un-audited
// sub-agents" note.

import { FIXTURES as applicationCriticFixtures } from "../../regression/sub-agents/application-critic";
import { FIXTURES as applicationDeciderFixtures } from "../../regression/sub-agents/application-decider";
import { FIXTURES as applicationDraftingFixtures } from "../../regression/sub-agents/application-drafting";
import { FIXTURES as compactSummaryFixtures } from "../../regression/sub-agents/compact-summary";
import { FIXTURES as companyBasicInfoFixtures } from "../../regression/sub-agents/company-basic-info";
import { FIXTURES as enrichJobFixtures } from "../../regression/sub-agents/enrich-job";
import { FIXTURES as findCompaniesFixtures } from "../../regression/sub-agents/find-companies";
import { FIXTURES as logoVerifierFixtures } from "../../regression/sub-agents/logo-verifier";
import { FIXTURES as memoryConsolidationFixtures } from "../../regression/sub-agents/memory-consolidation";
import { FIXTURES as parseResumeFixtures } from "../../regression/sub-agents/parse-resume";
import { FIXTURES as preScanFixtures } from "../../regression/sub-agents/pre-scan";
import { FIXTURES as profileEnrichmentCheckFixtures } from "../../regression/sub-agents/profile-enrichment-check";
import { FIXTURES as scanJobFixtures } from "../../regression/sub-agents/scan-job";
import { FIXTURES as shortlistJobsFixtures } from "../../regression/sub-agents/shortlist-jobs";

export type SubAgentClass = "judgement" | "transform";

export type FixtureRegistryEntry = {
  operation: string; // UsageOperation value
  scriptName: string; // audit script basename, e.g. "shortlist-jobs"
  subAgentName: string; // e.g. "shortlistJobsSubAgent"
  klass: SubAgentClass;
  fixtures: readonly unknown[];
};

// operation → static fixture set. Keys are UsageOperation values (the same
// `operation` string SubAgentRun rows carry), so a real run joins to its
// fixtures by `run.operation`.
export const FIXTURE_REGISTRY: Record<string, FixtureRegistryEntry> = {
  scan_job: entry(
    "scan_job",
    "scan-job",
    "scanJobSubAgent",
    "transform",
    scanJobFixtures,
  ),
  profile_enrichment_check: entry(
    "profile_enrichment_check",
    "profile-enrichment-check",
    "profileEnrichmentCheckSubAgent",
    "transform",
    profileEnrichmentCheckFixtures,
  ),
  enrich_job: entry(
    "enrich_job",
    "enrich-job",
    "enrichJobSubAgent",
    "transform",
    enrichJobFixtures,
  ),
  logo_verifier: entry(
    "logo_verifier",
    "logo-verifier",
    "logoVerifierSubAgent",
    "transform",
    logoVerifierFixtures,
  ),
  compact_summary: entry(
    "compact_summary",
    "compact-summary",
    "compactSummarySubAgent",
    "transform",
    compactSummaryFixtures,
  ),
  parse_resume: entry(
    "parse_resume",
    "parse-resume",
    "parseResumeSubAgent",
    "transform",
    parseResumeFixtures,
  ),
  memory_consolidation: entry(
    "memory_consolidation",
    "memory-consolidation",
    "memoryConsolidationSubAgent",
    "judgement",
    memoryConsolidationFixtures,
  ),
  application_drafting: entry(
    "application_drafting",
    "application-drafting",
    "applicationDraftingSubAgent",
    "judgement",
    applicationDraftingFixtures,
  ),
  application_decider: entry(
    "application_decider",
    "application-decider",
    "applicationDeciderSubAgent",
    "judgement",
    applicationDeciderFixtures,
  ),
  application_critic: entry(
    "application_critic",
    "application-critic",
    "applicationCriticSubAgent",
    "transform",
    applicationCriticFixtures,
  ),
  shortlist_jobs: entry(
    "shortlist_jobs",
    "shortlist-jobs",
    "shortlistJobsSubAgent",
    "judgement",
    shortlistJobsFixtures,
  ),
  pre_scan_job_batch: entry(
    "pre_scan_job_batch",
    "pre-scan",
    "runPreScan",
    "judgement",
    preScanFixtures,
  ),
  find_companies: entry(
    "find_companies",
    "find-companies",
    "findCompaniesSubAgent",
    "judgement",
    findCompaniesFixtures,
  ),
  company_basic_info: entry(
    "company_basic_info",
    "company-basic-info",
    "companyBasicInfoSubAgent",
    "judgement",
    companyBasicInfoFixtures,
  ),
};

function entry(
  operation: string,
  scriptName: string,
  subAgentName: string,
  klass: SubAgentClass,
  fixtures: readonly unknown[],
): FixtureRegistryEntry {
  return { operation, scriptName, subAgentName, klass, fixtures };
}

export function fixturesForOperation(
  operation: string,
): FixtureRegistryEntry | null {
  return FIXTURE_REGISTRY[operation] ?? null;
}

// Compact one-line description of a fixture's scenario shape, for the auditor's
// "already-tested shapes" list. Fixtures are heterogeneous per sub-agent, so
// this reads the small set of common descriptive fields rather than dumping the
// whole object (some embed large synthetic job pools we don't want in-prompt).
const DESC_FIELDS = [
  "notes",
  "expect",
  "expectDecision",
  "expectCloseReason",
  "expectNames",
  "mustShortlist",
  "mustNotShortlist",
  "slug",
  "titleContains",
  "companyName",
] as const;

export function describeFixture(f: unknown): string {
  if (!f || typeof f !== "object") return String(f);
  const o = f as Record<string, unknown>;
  const name =
    strField(o, "name") ??
    strField(o, "label") ??
    strField(o, "userEmail") ??
    "(unnamed)";
  const parts: string[] = [];
  for (const key of DESC_FIELDS) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) parts.push(`${key}=${v.trim()}`);
    else if (Array.isArray(v) && v.length)
      parts.push(`${key}=[${v.map(String).join(", ")}]`);
  }
  return parts.length ? `${name} — ${parts.join("; ")}` : name;
}

function strField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Every static fixture description for an operation, one per line (bullet list).
export function describeFixturesForOperation(operation: string): string[] {
  const e = fixturesForOperation(operation);
  if (!e) return [];
  return e.fixtures.map((f) => describeFixture(f));
}
