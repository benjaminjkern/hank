// Execute one BoardRecipe. This is the only thing that runs a recipe, and that
// is the whole safety argument: the invariants the 19 provider files each have
// to remember live here once, and a recipe has no way to omit them.
//
// What the runner owns and a recipe cannot touch:
//   - `assertPublicUrl` + the ambient abort/timeout, both free via `fetchText`
//   - the job caps and the `truncatedAt` accounting
//   - `attributes: rawAttrs(item)`
//   - detail concurrency
//   - the post-run validation gate
//
// NEVER build an AbortController in here. The abort signal is ambient
// (scrapeSignal.ts) precisely because it has to reach fetches several frames
// below the entry point; a local controller silently ignores the user's Stop.
// `fetchText` already asks for the right signal.

import { isRecord } from "@/utils/guards";
import { htmlToText } from "@/utils/html";
import { titleCaseSlug } from "@/utils/text";
import { urlHost } from "@/utils/url";

import { fetchText, rawAttrs } from "../ats/shared";
import { extractBlob } from "../generic/blobs";
import { parseFeedItems } from "../generic/feed";
import { sitemapLocs } from "../generic/sitemap";

import { findElements, readField, readPath } from "./fields";
import { recipeStructureErrors, validateRecipeRun } from "./validate";

import type { BoardRecipe, DetailStrategy, ListSource, Paging } from "./types";
import type { ScrapeResult, ScrapedJob } from "../types";

// Sized against runScrapeJobsForCompany's 90s budget, same reasoning as the
// wired providers. A recipe with a detail strategy pays a full page fetch per
// posting rather than a JSON row, so its ceiling is far lower — a board past it
// reports truncatedAt and simply never auto-closes anything, which is the
// correct trade for a learned source anyway.
const LIST_CAP = 300;
const DETAIL_CAP = 60;
const DETAIL_CONCURRENCY = 5;
const MAX_PAGES = 20;

export async function runBoardRecipe(
  recipe: BoardRecipe,
  opts: { boardUrl?: string } = {},
): Promise<ScrapeResult> {
  const structural = recipeStructureErrors(recipe);
  if (structural.length > 0) {
    return { ok: false, error: `recipe malformed: ${structural.join("; ")}` };
  }

  const boardUrl = opts.boardUrl ?? listUrl(recipe.list);
  const list = await fetchListItems(recipe, boardUrl);
  if (!list.ok) return { ok: false, error: list.error };

  const cap = recipe.detail ? DETAIL_CAP : LIST_CAP;
  const capped = list.items.slice(0, cap);

  const jobs = recipe.detail
    ? await mapWithDetail(capped, recipe, recipe.detail, boardUrl)
    : capped.map((item) => toScrapedJob(item, recipe, boardUrl));

  const kept = jobs.filter((j): j is ScrapedJob => j !== null);
  const validation = validateRecipeRun(kept, recipe, boardUrl);
  if (!validation.ok) {
    return {
      ok: false,
      error: `recipe produced unusable postings: ${validation.errors.join("; ")}`,
    };
  }

  // `truncatedAt` is a claim about COMPLETENESS and must be computed against
  // what actually came back, never against the cap constant — a dropped detail
  // fetch on a sub-cap board is missing from the list exactly like a capped
  // posting, and both make the board look smaller than it is.
  const boardTotal = list.declaredTotal ?? list.items.length;
  const truncated = boardTotal > validation.jobs.length || list.moreAvailable;

  return {
    ok: true,
    data: {
      companyName: companyNameFor(recipe, capped, boardUrl),
      jobs: validation.jobs,
      diagnostics: {
        provider: "recipe",
        fetchedUrl: boardUrl,
        pageLength: list.bytes,
        pageSnippet: list.snippet,
        ...(truncated ? { truncatedAt: validation.jobs.length } : {}),
      },
    },
  };
}

// -- the list half -----------------------------------------------------------

type ListResult =
  | {
      ok: true;
      // A JSON object per posting, or the row's HTML for an `html` source.
      items: RecipeItem[];
      declaredTotal: number | null;
      moreAvailable: boolean;
      bytes: number;
      snippet: string;
    }
  | { ok: false; error: string };

// An `html` row has no object to path into, so it carries its markup instead.
// Everything downstream branches on `htmlRow` being present.
type RecipeItem = { value: unknown; htmlRow?: string };

function listUrl(list: ListSource): string {
  return list.url;
}

async function fetchListItems(
  recipe: BoardRecipe,
  boardUrl: string,
): Promise<ListResult> {
  const items: RecipeItem[] = [];
  let bytes = 0;
  let snippet = "";
  let declaredTotal: number | null = null;
  let moreAvailable = false;

  const maxPages = recipe.paging ? pageLimit(recipe.paging) : 1;
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const url = pagedUrl(recipe, page, cursor);
    const fetched = await fetchListPage(recipe.list, url);
    if (!fetched.ok) {
      // A first-page failure is the whole board; a later one just ends paging
      // with what we have, and the truncation bit records the shortfall.
      if (page === 0) return { ok: false, error: fetched.error };
      moreAvailable = true;
      break;
    }
    bytes += fetched.bytes;
    if (!snippet) snippet = fetched.snippet;

    const pageItems = itemsFromPage(fetched.value, recipe);
    if (recipe.paging?.kind === "total-count") {
      const t = readPath(fetched.value, recipe.paging.totalPath);
      if (typeof t === "number") declaredTotal = t;
    }
    if (recipe.paging?.kind === "cursor") {
      const c = readPath(fetched.value, recipe.paging.cursorPath);
      cursor = typeof c === "string" && c !== "" ? c : null;
    }
    items.push(...pageItems);

    if (pageItems.length === 0) break;
    if (!recipe.paging) break;
    if (recipe.paging.kind === "cursor" && cursor == null) break;
    if (items.length >= LIST_CAP) {
      moreAvailable = true;
      break;
    }
  }

  if (items.length === 0) {
    return {
      ok: false,
      error: `no postings at ${boardUrl} (itemsPath "${recipe.itemsPath}")`,
    };
  }
  return { ok: true, items, declaredTotal, moreAvailable, bytes, snippet };
}

function pageLimit(paging: Paging): number {
  const declared =
    paging.kind === "total-count"
      ? Math.ceil(LIST_CAP / Math.max(1, paging.size))
      : paging.maxPages;
  return Math.min(Math.max(1, declared), MAX_PAGES);
}

function pagedUrl(
  recipe: BoardRecipe,
  page: number,
  cursor: string | null,
): string {
  const base = recipe.list.url;
  const paging = recipe.paging;
  if (!paging) return base;
  // Page 0 is the recipe's URL as written — the first request must be the one
  // the recipe was authored and verified against, not a synthesized `?page=1`.
  if (page === 0) return base;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return base;
  }
  switch (paging.kind) {
    case "page-param":
      u.searchParams.set(paging.param, String(paging.start + page));
      break;
    case "offset-param":
      u.searchParams.set(paging.param, String(page * paging.size));
      break;
    case "total-count":
      u.searchParams.set(paging.param, String(page * paging.size));
      break;
    case "cursor":
      if (cursor != null) u.searchParams.set(paging.param, cursor);
      break;
  }
  return u.toString();
}

type FetchedPage =
  | { ok: true; value: unknown; bytes: number; snippet: string }
  | { ok: false; error: string };

async function fetchListPage(
  list: ListSource,
  url: string,
): Promise<FetchedPage> {
  switch (list.kind) {
    case "json": {
      const res = await fetchText(url, {
        method: list.method ?? "GET",
        headers: { Accept: "application/json", ...(list.headers ?? {}) },
        ...(list.body != null ? { body: list.body } : {}),
      });
      if (!res.ok) return { ok: false, error: res.error };
      let value: unknown;
      try {
        value = JSON.parse(res.text);
      } catch {
        return { ok: false, error: `${url}: invalid JSON` };
      }
      return {
        ok: true,
        value,
        bytes: res.text.length,
        snippet: res.text.slice(0, 400),
      };
    }
    case "embedded": {
      const res = await fetchText(url, { headers: htmlHeaders() });
      if (!res.ok) return { ok: false, error: res.error };
      const value = extractBlob(res.text, list.blob);
      if (value == null) {
        return { ok: false, error: `${url}: no ${list.blob.kind} blob found` };
      }
      return {
        ok: true,
        value,
        bytes: res.text.length,
        snippet: res.text.slice(0, 400),
      };
    }
    case "html":
    case "feed":
    case "sitemap": {
      const res = await fetchText(url, { headers: htmlHeaders() });
      if (!res.ok) return { ok: false, error: res.error };
      return {
        ok: true,
        value: res.text,
        bytes: res.text.length,
        snippet: res.text.slice(0, 400),
      };
    }
  }
}

// Branded careers wrappers reject obvious bot UAs with a 403/406, and we're
// only reading public markup, so present as a browser for the HTML fetches.
export function htmlHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
}

function itemsFromPage(value: unknown, recipe: BoardRecipe): RecipeItem[] {
  if (recipe.list.kind === "html") {
    const html = typeof value === "string" ? value : "";
    return findElements(html, recipe.list.rowSelector, LIST_CAP).map((el) => ({
      value: {},
      htmlRow: el.outer,
    }));
  }
  if (recipe.list.kind === "feed") {
    const parsed = parseFeedItems(typeof value === "string" ? value : "");
    return (parsed ?? []).slice(0, LIST_CAP).map((v) => ({ value: v }));
  }
  if (recipe.list.kind === "sitemap") {
    const xml = typeof value === "string" ? value : "";
    const { pathContains, pathPrefix } = recipe.list;
    return sitemapLocs(xml)
      .filter((loc) => loc.includes(pathContains) && inPrefix(loc, pathPrefix))
      .slice(0, LIST_CAP)
      .map((loc) => ({ value: { url: loc } }));
  }
  const found = readPath(value, recipe.itemsPath);
  if (!Array.isArray(found)) return [];
  return found.map((v) => ({ value: v }));
}

function inPrefix(loc: string, pathPrefix: string | undefined): boolean {
  if (!pathPrefix || pathPrefix === "/") return true;
  try {
    return new URL(loc).pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

// -- item → job --------------------------------------------------------------

function toScrapedJob(
  item: RecipeItem,
  recipe: BoardRecipe,
  boardUrl: string,
): ScrapedJob | null {
  const read = (key: keyof BoardRecipe["fields"]) =>
    readField(recipe.fields[key], item.value, boardUrl, item.htmlRow);

  const title = read("title");
  const sourceUrl = read("sourceUrl");
  if (!title || !sourceUrl) return null;

  const location = read("location");
  const department = read("department");
  const compensation = read("compensation");
  const employmentType = read("employmentType");
  const body = read("rawContent");

  return {
    title,
    sourceUrl,
    rawContent:
      body ??
      (recipe.listOnly
        ? listOnlyBody(title, {
            location,
            department,
            compensation,
            employmentType,
          })
        : ""),
    ...(location ? { location } : {}),
    ...(department ? { department } : {}),
    ...(compensation ? { compensation } : {}),
    ...(employmentType ? { employmentType } : {}),
    // Same uncurated dump the wired providers do: whatever the board published
    // for this posting, minus description blobs, so a field nobody mapped isn't
    // lost. HTML rows have no object to dump.
    ...(isRecord(item.value) ? { attributes: rawAttrs(item.value) } : {}),
  };
}

// A board that publishes no body still owes the scan pass something to read.
// Only reachable when the recipe declares listOnly — otherwise a missing body
// is a recipe bug and validate.ts must see it as one.
function listOnlyBody(
  title: string,
  attrs: Record<string, string | null>,
): string {
  const meta = Object.values(attrs).filter(Boolean).join(" · ");
  return meta ? `${title}\n${meta}` : title;
}

// -- the detail half ---------------------------------------------------------

async function mapWithDetail(
  items: RecipeItem[],
  recipe: BoardRecipe,
  detail: DetailStrategy,
  boardUrl: string,
): Promise<Array<ScrapedJob | null>> {
  const out: Array<ScrapedJob | null> = [];
  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const chunk = items.slice(i, i + DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((item) => withDetail(item, recipe, detail, boardUrl)),
    );
    for (const s of settled) {
      out.push(s.status === "fulfilled" ? s.value : null);
    }
  }
  return out;
}

async function withDetail(
  item: RecipeItem,
  recipe: BoardRecipe,
  detail: DetailStrategy,
  boardUrl: string,
): Promise<ScrapedJob | null> {
  // sourceUrl is read pre-merge on purpose: it's what the detail fetch targets,
  // so it can't come from the detail response.
  const sourceUrl = readField(
    recipe.fields.sourceUrl,
    item.value,
    boardUrl,
    item.htmlRow,
  );
  if (!sourceUrl) return null;

  const target = detail.urlTemplate
    ? readField(
        { template: detail.urlTemplate },
        item.value,
        boardUrl,
        item.htmlRow,
      )
    : sourceUrl;
  if (!target) return null;

  const value = await fetchDetailValue(target, detail);
  // A dropped detail fetch drops the posting rather than emitting a bodyless
  // one — the shortfall then shows up as truncation, which is what stops a
  // partial read from looking like a smaller board.
  if (value == null) return null;

  const merged = isRecord(item.value)
    ? { ...item.value, detail: value }
    : { detail: value };
  return toScrapedJob(
    { value: merged, htmlRow: item.htmlRow },
    recipe,
    boardUrl,
  );
}

async function fetchDetailValue(
  url: string,
  detail: DetailStrategy,
): Promise<unknown> {
  const wantsJson = detail.extract.kind === "json";
  const res = await fetchText(url, {
    headers: wantsJson ? { Accept: "application/json" } : htmlHeaders(),
  });
  if (!res.ok) return null;

  switch (detail.extract.kind) {
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        return null;
      }
      return detail.extract.path
        ? readPath(parsed, detail.extract.path)
        : parsed;
    }
    case "text":
      return htmlToText(res.text);
    case "page":
      return pageTitleAndText(res.text);
    case "selector": {
      const el = findElements(res.text, detail.extract.selector, 1)[0];
      return el ? htmlToText(el.inner) : null;
    }
    default:
      return extractBlob(res.text, detail.extract);
  }
}

// The two things every posting page has, whatever built it. `<h1>` first
// because a `<title>` is usually suffixed with the company and the board name
// ("Senior Engineer | Careers | Acme"), which would land in Job.title verbatim;
// the suffix is trimmed off the fallback for the same reason.
function pageTitleAndText(
  html: string,
): { title: string; text: string } | null {
  const h1 = findElements(html, "h1", 1)[0];
  const fromH1 = h1 ? htmlToText(h1.inner).trim() : "";
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const fromTitle = titleTag
    ? htmlToText(titleTag[1])
        .split(/\s+[|–—-]\s+/)[0]
        .trim()
    : "";
  const title = fromH1 || fromTitle;
  const body = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const text = htmlToText(body);
  return title ? { title, text } : null;
}

// -- misc --------------------------------------------------------------------

function companyNameFor(
  recipe: BoardRecipe,
  items: RecipeItem[],
  boardUrl: string,
): string {
  for (const item of items) {
    const name = readField(
      recipe.companyName,
      item.value,
      boardUrl,
      item.htmlRow,
    );
    if (name) return name;
  }
  // The caller already knows the company — this is only a label on the scrape
  // result, so the board's host is a fine fallback.
  const host = urlHost(boardUrl);
  return host
    ? titleCaseSlug(host.replace(/^www\./, "").split(".")[0])
    : "Unknown";
}
