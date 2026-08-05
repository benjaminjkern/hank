// What the enrich chain is handed and what it reports back, per company and per
// batch.

import type { RunContext } from "@/server/agent/contracts";
import type { AmbiguousCompanyCandidate } from "@/server/subagents/registry/companyBasicInfo";

// One company to enrich. `context` (a disambiguating hint / suggestion
// reasoning) and `candidateUrl` (a board URL discovery already found) are
// forwarded to the URL hunter; `resolved` skips the hunt entirely because the
// user already picked which company a colliding name meant.
export type CompanyToEnrich = {
  companyId: string;
  slug: string;
  name: string;
  context?: string;
  candidateUrl?: string;
  resolved?: {
    canonicalName: string;
    sourceUrl: string;
    shortDescription: string;
  };
};

export type EnrichCompaniesArgs = RunContext & {
  sessionId: string;
  companies: CompanyToEnrich[];
  // Re-hunt + re-verify even when both flags are stamped. Use when the details
  // on file look wrong, not to fill gaps — gaps fill themselves.
  force?: boolean;
  concurrency?: number;
};

// What enriching ONE company produced.
//
// Which outcomes WRITE a status is the whole contract here: `cannot_scrape` is
// a finding about the company (the hunter exhausted its strategies), so the
// chain lands BLOCKED itself and no caller can forget to. `hunter_failed` is
// transient (an API error, a timeout) and `ambiguous` needs a human, so both
// leave the row untouched and hand the decision back — the batch renders a
// picker for one and retries the other, while the walkthrough sets the company
// aside because it has no picker to render mid-flow.
export type EnrichOutcome =
  | {
      kind: "enriched";
      hunted: boolean;
      logoVerified: boolean;
      sourceUrl: string | null;
      // The hunted URL already belonged to another user's Company row, so this
      // user's watchlist entry was re-pointed at that row and the stub deleted.
      attachedToExisting: boolean;
    }
  | { kind: "already_enriched" }
  // Chain wrote BLOCKED / CANNOT_SCRAPE.
  | { kind: "cannot_scrape"; reason: string }
  // Chain wrote nothing — the caller decides.
  | { kind: "ambiguous"; candidates: AmbiguousCompanyCandidate[] }
  | { kind: "hunter_failed"; error: string }
  // The Company row vanished between the caller reading it and the chain
  // running (removed from another tab).
  | { kind: "not_found" };

export type CompanyEnrichResult = {
  // The company the chain ENDED on — differs from the input id when the stub
  // attached to an existing row.
  companyId: string;
  // Best name to show the user: the hunter's canonical name once there is one,
  // else what the caller asked about.
  name: string;
  outcome: EnrichOutcome;
};

export type EnrichProgressEvent =
  | { type: "company_started"; companyId: string; name: string }
  | { type: "company_done"; result: CompanyEnrichResult };

export type EnrichCompaniesResult = {
  results: CompanyEnrichResult[];
};
