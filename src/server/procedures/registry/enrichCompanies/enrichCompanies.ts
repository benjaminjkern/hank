// The bounded worker pool over the per-company enrich — the SINGLE primitive
// behind the enrich_companies tool, the company_checklist / disambiguation
// submissions, and the walkthrough's on-entry backfill.
//
// An async generator: it streams one event per company as each starts and
// finishes, which the submission handlers render. One company's own enrich is
// not a generator (see enrichOne.ts). No hard wall timeout — the hunter's turn
// cap and the user's Stop button are the bounds.

import type { RunTrace } from "@/server/agent/contracts";
import { openTraceSpan } from "@/server/platform/trace/span";

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

export async function* runEnrichCompanies(
  outerArgs: EnrichCompaniesArgs,
): AsyncGenerator<EnrichProgressEvent, EnrichCompaniesResult> {
  // Generators can't ride withTraceSpan (it would have to drain them), so the
  // span is opened explicitly and closed in a finally — which also covers a
  // consumer abandoning the batch early.
  const span = openTraceSpan("enrich_companies", outerArgs.trace);
  try {
    return yield* enrichBatch({ ...outerArgs, trace: span.trace });
  } finally {
    span.close();
  }
}

async function* enrichBatch(
  args: EnrichCompaniesArgs & { trace?: RunTrace },
): AsyncGenerator<EnrichProgressEvent, EnrichCompaniesResult> {
  const { companies } = args;
  const concurrency = args.concurrency ?? ENRICH_CONCURRENCY;

  const results: CompanyEnrichResult[] = [];
  // Workers push events into a shared queue; the generator body drains it.
  const queue: EnrichProgressEvent[] = [];
  let wake: (() => void) | null = null;
  const waitForEvent = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  const signalWake = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  // Shared cursor — each worker pulls the next company until the list is
  // drained (or the user hits Stop).
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, companies.length);
  let remaining = workerCount;

  const worker = async () => {
    while (true) {
      if (args.signal?.aborted) break;
      const i = nextIndex++;
      if (i >= companies.length) break;
      const company = companies[i];
      queue.push({
        type: "company_started",
        companyId: company.companyId,
        name: company.name,
      });
      signalWake();
      // A per-company crash becomes a hunter_failed outcome — one bad company
      // never aborts the batch.
      // eslint-disable-next-line no-await-in-loop -- this await IS the concurrency limit: N workers draining a shared queue is how the pool stays bounded
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
      queue.push({ type: "company_done", result });
      signalWake();
    }
  };

  for (let w = 0; w < workerCount; w++) {
    void worker().finally(() => {
      remaining -= 1;
      signalWake();
    });
  }

  while (remaining > 0 || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    // eslint-disable-next-line no-await-in-loop -- parks until a worker reports — waiting is the point
    if (remaining > 0) await waitForEvent();
  }

  return { results };
}

// For callers that aren't on a streaming path (the tool returns one result
// string; the walkthrough enriches exactly one company): run to completion and
// return just the aggregate, discarding the live events.
export async function runEnrichCompaniesCollect(
  args: EnrichCompaniesArgs,
): Promise<EnrichCompaniesResult> {
  const gen = runEnrichCompanies(args);
  let step = await gen.next();
  // eslint-disable-next-line no-await-in-loop -- draining a generator — each step is produced by the previous one
  while (!step.done) step = await gen.next();
  return step.value;
}
