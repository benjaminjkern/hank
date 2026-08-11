// The gate every recipe run passes before its jobs are allowed out of the
// scrape layer. A hand-written provider is verified once by a human and then
// trusted; a recipe is authored by inference and has to re-prove itself on
// every run, because the failure mode is silent — a drifted selector returns
// rows that are structurally fine and semantically garbage.
//
// Two rules shape what's here:
//
//   FAIL THE RUN, NOT THE ROW. A recipe that produces 40 good jobs and 60 bad
//   ones is broken, and letting the 40 through writes real Job rows off a
//   broken reader. Beyond a small per-row tolerance the whole run is rejected
//   so the reader quarantines and gets re-authored.
//
//   sourceUrl IS THE ONE THAT CANNOT BE WRONG. It's `Job.sourceUrl @unique`,
//   the global dedupe key — a wrong or unstable URL doesn't degrade, it
//   permanently orphans rows and can hand a posting to the wrong company. So it
//   gets the strictest checks: absolute, same registrable domain as the board,
//   fully distinct, no volatile query params.

import { urlHost } from "@/utils/url";

import type { BoardRecipe } from "./types";
import type { ScrapedJob } from "../types";

// Above this fraction of rejected rows the run is scrapped rather than trimmed.
const MAX_BAD_ROW_RATIO = 0.2;
const MIN_TITLE_CHARS = 3;
const MAX_TITLE_CHARS = 200;
const MIN_BODY_CHARS = 40;
// Title-repetition guard. Set well below what a genuine board hits — a board
// that posts one title in five cities still clears 0.4 easily — so this only
// fires on wholesale duplication.
const MIN_DISTINCT_TITLE_RATIO = 0.4;
const MIN_ROWS_FOR_TITLE_RATIO = 5;
// A board that genuinely publishes no body still has to yield the title line
// and its attributes, which is what the list-only providers produce.
const MIN_LIST_ONLY_BODY_CHARS = 20;

// Query params whose value changes per request. A sourceUrl carrying one is not
// a stable identity for a posting — it mints a new Job row every scrape and
// delists the previous one.
const VOLATILE_PARAMS = new Set([
  "page",
  "offset",
  "limit",
  "cursor",
  "token",
  "sessionid",
  "session_id",
  "timestamp",
  "ts",
  "sig",
  "signature",
  "_",
]);

export type RecipeValidation =
  | { ok: true; jobs: ScrapedJob[]; dropped: number }
  | { ok: false; errors: string[] };

// `boardUrl` is what the recipe was authored against — the registrable-domain
// comparison anchors on it, so a template pointing somewhere else is caught.
export function validateRecipeRun(
  jobs: ScrapedJob[],
  recipe: BoardRecipe,
  boardUrl: string,
): RecipeValidation {
  const errors: string[] = [];
  if (jobs.length === 0) {
    return { ok: false, errors: ["recipe produced no jobs"] };
  }

  const boardDomain = registrableDomain(boardUrl);
  const minBody = recipe.listOnly ? MIN_LIST_ONLY_BODY_CHARS : MIN_BODY_CHARS;

  const kept: ScrapedJob[] = [];
  const reasons = new Map<string, number>();
  const noteBad = (reason: string) => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };

  for (const job of jobs) {
    const title = job.title?.trim() ?? "";
    if (title.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS) {
      noteBad("title missing or implausible length");
      continue;
    }
    const urlProblem = sourceUrlProblem(job.sourceUrl, boardDomain);
    if (urlProblem) {
      noteBad(urlProblem);
      continue;
    }
    if ((job.rawContent?.trim().length ?? 0) < minBody) {
      noteBad(`rawContent shorter than ${minBody} chars`);
      continue;
    }
    kept.push(job);
  }

  // Repeated titles are the signature of a locator that matched something other
  // than postings — page chrome, or the same marketing page in every locale
  // (Rippling's `/careers/eng-interview-kit` × 4 languages read as 52 roles,
  // all with distinct URLs, so nothing else caught it).
  //
  // A real board DOES repeat a title — "Software Engineer" in five cities — so
  // the bar is a ratio, not uniqueness, and it only applies once there are
  // enough rows for the ratio to mean anything.
  const distinctTitles = new Set(kept.map((j) => j.title.trim().toLowerCase()));
  if (kept.length >= 2 && distinctTitles.size === 1) {
    errors.push(
      `every posting has the same title ("${kept[0].title.trim()}") — the title locator is matching page chrome, not the row`,
    );
  } else if (
    kept.length >= MIN_ROWS_FOR_TITLE_RATIO &&
    distinctTitles.size < kept.length * MIN_DISTINCT_TITLE_RATIO
  ) {
    errors.push(
      `only ${distinctTitles.size} distinct titles across ${kept.length} postings — the list is repeating a small set of pages (locale variants or a template), not enumerating roles`,
    );
  }

  // Duplicate URLs mean the locator isn't identifying the posting. The upsert
  // would silently collapse them (last wins), so catch it here where it reads
  // as the recipe bug it is.
  const distinctUrls = new Set(kept.map((j) => j.sourceUrl));
  if (distinctUrls.size !== kept.length) {
    errors.push(
      `${kept.length - distinctUrls.size} duplicate sourceUrls — the URL locator doesn't identify a posting`,
    );
  }

  const dropped = jobs.length - kept.length;
  if (dropped > jobs.length * MAX_BAD_ROW_RATIO) {
    const detail = [...reasons.entries()]
      .map(([reason, n]) => `${n}× ${reason}`)
      .join("; ");
    errors.push(
      `${dropped}/${jobs.length} postings failed field checks (${detail})`,
    );
  }
  if (kept.length === 0) {
    errors.push("no posting survived field checks");
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, jobs: kept, dropped };
}

function sourceUrlProblem(
  sourceUrl: string | undefined,
  boardDomain: string | null,
): string | null {
  if (!sourceUrl) return "sourceUrl missing";
  let u: URL;
  try {
    u = new URL(sourceUrl);
  } catch {
    return "sourceUrl not absolute";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return "sourceUrl is not http(s)";
  }
  // An unfilled `{slug}` placeholder reaching here means the template silently
  // produced a literal — fields.ts voids those, so this is belt-and-braces
  // against a `literal` spec that happens to contain braces.
  if (u.href.includes("{") || u.href.includes("}")) {
    return "sourceUrl still contains an unfilled placeholder";
  }
  for (const key of u.searchParams.keys()) {
    if (VOLATILE_PARAMS.has(key.toLowerCase())) {
      return `sourceUrl carries the volatile query param "${key}"`;
    }
  }
  // Cross-domain URLs are how a bad locator hands postings to another company.
  // The board itself is often on a different host than the company site, so we
  // anchor on the board URL rather than the company's domain.
  const jobDomain = registrableDomain(sourceUrl);
  if (boardDomain && jobDomain && jobDomain !== boardDomain) {
    return `sourceUrl host ${jobDomain} doesn't match the board's ${boardDomain}`;
  }
  return null;
}

// Last two labels. Wrong for multi-part public suffixes (`.co.uk`), and
// deliberately so: erring toward "same domain" only ever makes this check more
// permissive, and a false REJECT would kill a working board.
function registrableDomain(url: string): string | null {
  const host = urlHost(url)?.toLowerCase();
  if (!host) return null;
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

// Structural check on a recipe before it is ever run — catches the shapes that
// would otherwise fail confusingly deep inside the runner. Returns the reasons
// it can't be run, empty when it's well-formed.
export function recipeStructureErrors(recipe: BoardRecipe): string[] {
  const errors: string[] = [];
  if (recipe.version !== 1) {
    errors.push(`unsupported recipe version ${String(recipe.version)}`);
  }
  if (!recipe.fields?.title) errors.push("fields.title is required");
  if (!recipe.fields?.sourceUrl) errors.push("fields.sourceUrl is required");
  // A sitemap is a list of URLs and nothing else, so it can never fill a title
  // or a body on its own.
  if (recipe.list?.kind === "sitemap" && !recipe.detail) {
    errors.push("a sitemap list source requires a detail strategy");
  }
  // Same for any list that doesn't carry the body: without a detail strategy
  // every row would fail the rawContent floor, which reads as a field bug
  // rather than the missing-strategy it is.
  if (!recipe.fields?.rawContent && !recipe.detail && !recipe.listOnly) {
    errors.push(
      "no rawContent field and no detail strategy — set one, or listOnly if the board publishes no body",
    );
  }
  return errors;
}
