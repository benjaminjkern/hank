// Is this module the process entrypoint (run directly), or was it imported?
//
// Each audit script runs its audit at top level. That's correct when the script
// is the entrypoint (`pnpm exec tsx scripts/regression/sub-agents/shortlist-jobs.ts`)
// but wrong when the module is IMPORTED for its exported FIXTURES — e.g. the
// sub-agent runtime audit's fixtureRegistry pulls in every audit script to read
// the static fixtures it should compare real runs against. Guarding the
// top-level run with `if (isEntrypoint(import.meta.url))` makes the import
// side-effect-free while keeping standalone `tsx` invocation working.
//
// Kept in its own leaf module (node built-ins only) so importing the guard
// doesn't drag in lib/harness's PrismaClient construction.

import { realpathSync } from "fs";
import { fileURLToPath } from "url";

export function isEntrypoint(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
