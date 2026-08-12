// The company_checklist submission: create stubs for the picked names, then
// enrich them.
//
// "Enrich" here is identity only — careers URL, canonical name, description,
// logo. Roles are NOT pulled in: that happens the first time the user walks the
// company (or on an explicit scrape_jobs_for_company). So the ✓ lines carry no
// role count, and every company lands at NEW, which is where whats_next's
// backlog picks them up.
//
// The ✓ lines are the narration; the caller asks whether to keep hunting. A
// disambiguation picker is the one exception: it's a genuine wait-for-user
// question, so it's reported back and the caller stops rather than stacking
// another widget under an unanswered one.

import { statusEvent, widgetEvent } from "@/server/agent/contracts";
import type { TurnEvent } from "@/server/agent/contracts";
import { prisma } from "@/server/db/prisma";
import { createCompanyStubs } from "@/server/entities/companies/createCompanyStubs";
import type {
  PickedCompany,
  DisambiguationResolution,
} from "@/server/widgets/parse";

import { runEnrichCompanies } from "./enrichCompanies";

import type { CompanyEnrichResult, WatchlistAddArgs } from "./types";

// Shape the disambiguation widget renders + round-trips. `companyId` is the
// stub (unresolved, NEW) the picker resolves on selection; each candidate
// carries the verified board URL the hunter offered.
type AmbiguousCompanyForPicker = {
  companyId: string;
  name: string;
  candidates: Array<{
    chosenUrl: string;
    canonicalName: string;
    shortDescription: string;
  }>;
};

// One user-facing line per finished company. Terminal outcomes stay plain — the
// raw hunter reason (ATS slugs, 404s, fetch_url) is developer-speak.
function lineFor(result: CompanyEnrichResult): string | null {
  switch (result.outcome.kind) {
    case "enriched":
    case "already_enriched":
      return `✓ Added ${result.name}.`;
    case "cannot_scrape":
      return `I couldn't find a readable job board for ${result.name} — they're on your list, but I've set them aside. If you have their careers link, send it over.`;
    case "hunter_failed":
      return `I couldn't look up ${result.name} just now — they're on your list and we can try again.`;
    case "not_found":
      return null;
    case "ambiguous":
      // Deferred to the picker — don't claim it was added.
      return null;
  }
}

// `awaitingDisambiguation` = a picker is on screen and owes an answer, so the
// caller must not follow it with anything. `added` names the companies that
// actually landed — what the caller reports back to the user, so a name that
// failed its lookup or was already on the list isn't in it.
export type ChecklistAddResult = {
  awaitingDisambiguation: boolean;
  added: string[];
};

// Did this company end up on the watchlist? "already_enriched" counts: the
// company is there and ready, which is what the user asked for.
function landed(result: CompanyEnrichResult): boolean {
  return (
    result.outcome.kind === "enriched" ||
    result.outcome.kind === "already_enriched"
  );
}

export async function* runChecklistAdd(
  picks: PickedCompany[],
  args: WatchlistAddArgs,
): AsyncGenerator<TurnEvent, ChecklistAddResult> {
  // Create stubs first (dedupe-aware), then enrich the fresh ones. Each pick's
  // disambiguation context (suggestion reasoning) + captured board URL ride
  // through createCompanyStubs onto the outcome so the enrich step can forward
  // them to the URL hunter. Names already on the list come back `existed` and
  // are skipped.
  const stubs = await createCompanyStubs(
    args.userId,
    picks.map((p) => ({
      name: p.name,
      context: p.context,
      candidateUrl: p.url,
    })),
  );
  const toEnrich = stubs
    .filter((s) => s.kind !== "existed")
    .map((s) => ({
      companyId: s.companyId,
      slug: s.slug,
      name: s.name,
      context: s.context,
      candidateUrl: s.candidateUrl,
    }));

  if (toEnrich.length === 0) {
    yield {
      type: "text",
      text:
        picks.length === 1
          ? `That one's already on your list.`
          : `Those are already on your list.`,
    };
    return { awaitingDisambiguation: false, added: [] };
  }

  const willRun = toEnrich.length;
  yield statusEvent(
    `Looking up ${willRun} ${willRun === 1 ? "company" : "companies"} — I check each careers page, so give me a moment…`,
  );

  const it = runEnrichCompanies({ ...args, companies: toEnrich });

  // Companies the hunter couldn't disambiguate — collected here and surfaced as
  // ONE picker at the end of the batch rather than pausing mid-loop (the pool
  // can't yield a widget and wait per company).
  const ambiguous: AmbiguousCompanyForPicker[] = [];
  const added: string[] = [];
  let step = await it.next();
  while (!step.done) {
    const ev = step.value;
    if (ev.type === "company_started") {
      yield statusEvent(`Looking up ${ev.name}…`);
    } else {
      const { result } = ev;
      if (landed(result)) added.push(result.name);
      if (result.outcome.kind === "ambiguous") {
        ambiguous.push({
          companyId: result.companyId,
          name: result.name,
          candidates: result.outcome.candidates.map((c) => ({
            chosenUrl: c.sourceUrl,
            canonicalName: c.canonicalName,
            shortDescription: c.shortDescription,
          })),
        });
      } else {
        const line = lineFor(result);
        if (line) yield { type: "text", text: line };
        // This company is now persisted — show it on the dashboard immediately
        // rather than waiting for the whole batch to finish.
        yield { type: "refresh_viewed_state" };
      }
    }
    // eslint-disable-next-line no-await-in-loop -- draining a generator — each step is produced by the previous one
    step = await it.next();
  }

  // Name collisions: surface the disambiguation picker (a genuine wait-for-user
  // question). Resolving it chains into runDisambiguationResolution.
  if (ambiguous.length > 0) {
    yield {
      type: "text",
      text:
        ambiguous.length === 1
          ? `One name matched more than one company — which did you mean?`
          : `A few names matched more than one company — pick which you meant.`,
    };
    yield widgetEvent("company_disambiguation", {
      companies: ambiguous,
    });
    return { awaitingDisambiguation: true, added };
  }
  return { awaitingDisambiguation: false, added };
}

// Resolve the user's disambiguation picks: commit the chosen board URL through
// the same chain (which skips the hunt because the URL is already decided) and
// narrate one line each.
export async function* runDisambiguationResolution(
  resolved: DisambiguationResolution[],
  args: WatchlistAddArgs,
): AsyncGenerator<TurnEvent, string[]> {
  const companies = await prisma.company.findMany({
    where: { id: { in: resolved.map((r) => r.companyId) } },
    select: { id: true, slug: true },
  });
  const slugById = new Map(companies.map((c) => [c.id, c.slug]));

  const toEnrich = resolved
    // A stub removed between render and submit just drops out.
    .filter((r) => slugById.has(r.companyId))
    .map((r) => ({
      companyId: r.companyId,
      slug: slugById.get(r.companyId)!,
      name: r.canonicalName,
      resolved: {
        canonicalName: r.canonicalName,
        sourceUrl: r.chosenUrl,
        shortDescription: r.shortDescription,
      },
    }));
  if (toEnrich.length === 0) return [];

  const it = runEnrichCompanies({ ...args, companies: toEnrich });

  const added: string[] = [];
  let step = await it.next();
  while (!step.done) {
    const ev = step.value;
    if (ev.type === "company_started") {
      yield statusEvent(`Setting up ${ev.name}…`);
    } else {
      if (landed(ev.result)) added.push(ev.result.name);
      const line = lineFor(ev.result);
      if (line) yield { type: "text", text: line };
      yield { type: "refresh_viewed_state" };
    }
    // eslint-disable-next-line no-await-in-loop -- draining a generator — each step is produced by the previous one
    step = await it.next();
  }
  return added;
}
