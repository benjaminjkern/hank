// The scan procedure's public surface: the body-reading pass over one company's
// prescan survivors. `runScan` is the entry — it enriches each NEW job (pass 1,
// cached and user-independent) then runs the per-user match (pass 2), which
// decides SCANNED-vs-CLOSED per job. Enrichment populates the summary the
// shortlist rollup later reads instead of full bodies.
//
// This folder owns everything around the two sub-agents: the candidate context
// (loadContext.ts), the per-job passes + persistence calls (scanOneJob.ts), and
// the bounded fan-out (runScan.ts). The sub-agents themselves
// (subagents/registry/enrichJob.ts, subagents/registry/scanJob.ts) read and
// write nothing.
//
// Import from `@/server/procedures/registry/scan` — never a deep path, so the
// internal file split stays free to move.

export { runScan, type RunScanResult } from "./runScan";
export { runEnrichJobBody, type EnrichJobBodyOutcome } from "./enrichJobBody";
