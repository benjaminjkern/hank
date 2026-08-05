// Last-resort board discovery: given a company's careers page (or homepage),
// find the real ATS board hiding behind it.
//
// Two enterprise ATSes can't be reached by slug-guessing or host-matching, so
// neither `detectAts` nor `probeAtsBoards` can find them — the only path is to
// read the branded page they're fronted by:
//
//   - **Workday** boards live at {tenant}.{shard}.myworkdayjobs.com/{site}. The
//     shard (wd1..wd108+) is an unguessable data-center marker — Expedia is on
//     wd108 — so there is no slug to guess. Enterprises front it with a branded
//     domain (lifeatexpediagroup.com, careers.{co}.com) whose HTML embeds the
//     real board URL.
//   - **iCIMS'** modern career sites (Jibe) render an Angular app on a custom
//     domain and expose JSON at {careers-origin}/api/jobs. The domain is
//     per-company, so it can't be derived either.
//
// Both were separate sub-agent tools (`resolve_workday_board`,
// `resolve_icims_board`), which meant the hunter had to correctly identify
// WHICH enterprise ATS it was looking at before it could pick the right tool —
// and in seven weeks of production it reached for the iCIMS one four times.
// Now `test_scrape` calls this automatically whenever a URL isn't a recognized
// board, so the hunter just asks "can you get jobs out of this page?".
//
// Deliberately NOT wired into `testScrape` itself: `probeAtsBoards` fans that
// out over ~15 slug candidates in parallel, and a page fetch per miss would
// multiply badly. This runs once, on the tool's detect-miss path.

import { assertPublicUrl } from "@/server/platform/net/assertPublicUrl";

import { extractWorkdayBoardUrlFromHtml } from "./ats";
import { scrapeFetchSignal } from "./scrapeSignal";

import { testScrape } from "./index";

import type { AtsProvider } from "./types";

// Branded careers wrappers reject obvious bot UAs (403/406). We only read HTML
// to locate the board URL — no auth, no writes.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
// A board with one "Open Application" template entry isn't a real board.
const MIN_REAL_JOBS = 2;
// Cap the iCIMS origin fan-out — the page can carry a lot of hrefs.
const MAX_ICIMS_ORIGINS = 6;

export type ResolvedBoard = {
  boardUrl: string;
  provider: AtsProvider;
  jobCount: number;
  companyName: string;
  sampleTitles: string[];
};

export type ResolveBoardResult =
  { ok: true; board: ResolvedBoard } | { ok: false; reason: string };

export async function resolveBoardFromCareersPage(
  url: string,
): Promise<ResolveBoardResult> {
  // iCIMS fast path: the URL the hunter landed on is usually the careers site
  // itself, so try its own origin before paying for a page fetch.
  const origin = originOf(url);
  if (origin) {
    const direct = await verify(`${origin}/api/jobs`);
    if (direct) return { ok: true, board: direct };
  }

  const html = await fetchHtml(url);
  if (html === null) {
    return {
      ok: false,
      reason: `couldn't fetch ${url} to look for an embedded board`,
    };
  }

  // Workday: the board URL is embedded verbatim in the branded page's HTML.
  const workdayBoard = extractWorkdayBoardUrlFromHtml(html);
  if (workdayBoard) {
    const verified = await verify(workdayBoard);
    if (verified) return { ok: true, board: verified };
    return {
      ok: false,
      reason: `found a Workday board (${workdayBoard}) embedded in ${url}, but it didn't produce ${MIN_REAL_JOBS}+ real jobs`,
    };
  }

  // iCIMS: probe the Jibe API on any careers-ish origin the page points at.
  for (const candidate of icimsOriginCandidates(url, html)) {
    const verified = await verify(`${candidate}/api/jobs`);
    if (verified) return { ok: true, board: verified };
  }

  return {
    ok: false,
    reason: `no Workday board URL or iCIMS jobs API found via ${url}. The company may be on an unsupported ATS, or the board is injected by client-side JS that isn't in the static HTML — try a deeper /careers or /jobs page, or web_search "<Company> careers"`,
  };
}

async function verify(boardUrl: string): Promise<ResolvedBoard | null> {
  const r = await testScrape(boardUrl);
  if (!r.ok || r.jobCount < MIN_REAL_JOBS) return null;
  return {
    boardUrl,
    provider: r.provider,
    jobCount: r.jobCount,
    companyName: r.companyName,
    sampleTitles: r.sampleTitles,
  };
}

// Returns the body even on a non-2xx: Workday wrappers often serve an error
// shell that still carries the board URL. null = the fetch itself failed.
async function fetchHtml(url: string): Promise<string | null> {
  try {
    // SSRF guard: this URL is careers-page/homepage input, so refuse internal
    // targets before fetching (a BlockedUrlError degrades to null below).
    await assertPublicUrl(url);
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: scrapeFetchSignal(FETCH_TIMEOUT_MS),
    });
    return await res.text();
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Careers origins worth probing for an iCIMS `/api/jobs`. The page's own origin
// first, then the conventional careers subdomains synthesized from the
// registrable domain (www.amd.com → careers.amd.com), then any careers-ish or
// icims.com link in the HTML — so a bare homepage still resolves.
function icimsOriginCandidates(inputUrl: string, html: string): string[] {
  const origins: string[] = [];
  const push = (o: string | null) => {
    if (o && !origins.includes(o)) origins.push(o);
  };

  try {
    const u = new URL(inputUrl);
    push(u.origin);
    const parts = u.hostname.toLowerCase().split(".");
    const registrable =
      parts.length > 2 ? parts.slice(-2).join(".") : u.hostname.toLowerCase();
    for (const sub of ["careers", "jobs"]) {
      if (!u.hostname.toLowerCase().startsWith(`${sub}.`)) {
        push(`https://${sub}.${registrable}`);
      }
    }
  } catch {
    /* non-URL input — rely on the hrefs below */
  }

  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let abs: URL;
    try {
      abs = new URL(m[1], inputUrl);
    } catch {
      continue;
    }
    const host = abs.hostname.toLowerCase();
    if (
      /^(careers|jobs|talent|join|work)\b/.test(host) ||
      host.includes("icims.com")
    ) {
      push(abs.origin);
    }
  }

  // The page's own origin was already probed by the caller's fast path.
  return origins.slice(0, MAX_ICIMS_ORIGINS);
}
