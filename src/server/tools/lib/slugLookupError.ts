// The one place a failed slug lookup becomes a ToolResult. Every tool handler
// that resolves an entity slug ends its failure branch here, so the wording and
// the `resolve:*` audit keys have a single copy instead of one per call site.
//
// This is the counterpart to entities/resolveBySlug: that side reports what
// didn't resolve, this side decides how it reads. Sentences here name tools
// (`list_companies`, `list_jobs`) and tool params (`sourceJob`) on purpose —
// pointing the model at the call that produces a valid slug is what lets it
// self-correct in the same turn, and that vocabulary belongs on this side of
// the boundary.

import type { SlugLookupFail } from "@/server/entities/resolveBySlug";

import { toolError } from "./toolError";

import type { ToolResult } from "./types";

// `source` is the calling tool's name, and passing it keys the audit by that
// tool (`update_job:not_found:company`) instead of by the resolver
// (`resolve:company_not_found`) — so "the model keeps mis-slugging on THIS
// tool" stays visible. Both spellings predate this helper and are preserved
// per-call-site; see docs/INCOMPLETE_MIGRATIONS.md for the pending decision on
// collapsing them.
//
// `itemPrefix` labels which element of a batch failed ("item 3: "), for the
// tools that resolve a slug per array entry.
export function slugLookupError(
  fail: SlugLookupFail,
  opts: { source?: string; itemPrefix?: string } = {},
): ToolResult {
  return toolError(
    "ENTITY_NOT_FOUND",
    `${opts.itemPrefix ?? ""}${describe(fail)}`,
    opts.source
      ? `${opts.source}:not_found:${fail.entity}`
      : `resolve:${fail.entity}_not_found`,
  );
}

function describe(fail: SlugLookupFail): string {
  const { attempted, availableSlugs } = fail;
  const list = availableSlugs.join(", ");
  switch (fail.entity) {
    case "company":
      return `No company matches "${attempted}". ${
        list
          ? `Your companies: ${list}. Use one of those slugs`
          : "Your watchlist is empty"
      }, or call list_companies to search.`;
    case "job":
      return `No job matches "${attempted}". Job slugs come from list_jobs / scrape_jobs_for_company — re-run one to get the current slug for this role.`;
    case "opportunity":
      return `No lead matches "${attempted}".${list ? ` Your leads: ${list}.` : ""}`;
    case "contact":
      return `No contact matches "${attempted}".`;
    case "job_interaction":
      return `You don't have a tracked application for "${attempted}" yet, so it can't be the source of this lead. Leave sourceJob unset for an agency-posting / cold inbound.`;
  }
}
