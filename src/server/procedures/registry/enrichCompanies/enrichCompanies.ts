// The bounded worker pool over the per-company enrich — the SINGLE primitive
// behind the enrich_companies tool, the discovery commit and the disambiguation
// answer, and the walkthrough's on-entry backfill.
//
// Reports one progress event per company as each starts and finishes, through
// the optional `onProgress` — the submission handlers render them; the tool and
// the walkthrough just take the result. One company's own enrich is
// enrichOne.ts. No hard wall timeout — the hunter's turn cap and the user's Stop
// button are the bounds.

import { procedure } from "@/server/procedures/lib/procedure";

import { enrichOne } from "./enrichOne";

import type {
  CompanyEnrichResult,
  EnrichCompaniesArgs,
  EnrichCompaniesResult,
  EnrichProgressEvent,
} from "./types";

// Each company runs a multi-turn URL hunter plus a vision logo check, so we
// bound how many run at once — five in flight, the next starts as one finishes.
// There is no cap on how many a single call enriches: the user gets everything
// they asked for in one pass. The "keep it to ~20 at a time" guidance is
// advisory and lives in Hank's prompt (it's the user's tokens).
const ENRICH_CONCURRENCY = 5;

export const runEnrichCompanies = procedure(
  "enrich_companies",
  async (
    args: EnrichCompaniesArgs & {
      // Awaited by the worker that reports it, so a slow renderer holds that
      // worker rather than letting events pile up unseen.
      onProgress?: (event: EnrichProgressEvent) => Promise<void>;
    },
  ): Promise<EnrichCompaniesResult> => {
    const { companies } = args;
    const concurrency = args.concurrency ?? ENRICH_CONCURRENCY;
    const results: CompanyEnrichResult[] = [];

    // Shared cursor — each worker pulls the next company until the list is
    // drained (or the user hits Stop).
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        if (args.signal?.aborted) break;
        const i = nextIndex++;
        if (i >= companies.length) break;
        const company = companies[i];
        // eslint-disable-next-line no-await-in-loop -- this worker's own progress line, said before its company starts
        await args.onProgress?.({
          type: "company_started",
          companyId: company.companyId,
          name: company.name,
        });
        // A per-company crash becomes a hunter_failed outcome — one bad company
        // never aborts the batch.
        // eslint-disable-next-line no-await-in-loop -- this await IS the concurrency limit: N workers draining a shared cursor is how the pool stays bounded
        const result = await enrichOne(company, args).catch(
          (err): CompanyEnrichResult => ({
            companyId: company.companyId,
            name: company.name,
            outcome: {
              kind: "hunter_failed",
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        );
        results.push(result);
        // eslint-disable-next-line no-await-in-loop -- reports the company this worker just finished
        await args.onProgress?.({ type: "company_done", result });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, companies.length) }, worker),
    );
    return { results };
  },
);
