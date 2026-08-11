// How much of the long tail can we read WITHOUT an LLM?
//
// Runs the deterministic probe against real boards that no wired provider
// recognizes, and prints the coverage. That number is the point of the harness:
// it's the acceptance test for the probe tier AND the input to every later
// decision about how much the paid recon pass has to carry.
//
// No LLM and no DB — it hits live third-party boards and nothing else, so it's
// free to run. It IS network-dependent, so a red row is as often "this company
// stopped hiring" as "we broke something"; check the URL by hand before
// treating a regression as real, and swap the row if the board is gone.
//
//   pnpm ats:probe-corpus                  # the whole corpus
//   pnpm ats:probe-corpus <url>            # one URL, verbose

import "dotenv/config";

import { detectAts } from "../../src/server/scrape/ats";
import { probeGenericBoard } from "../../src/server/scrape/generic/genericProbe";

// `expect` is the baseline this row asserts:
//   jobs        — the probe should read this board
//   needs-browser — the postings only exist after client-side render; we expect
//                   a miss here today, and the row exists so we notice if that
//                   ever changes (or if a headless-authored recipe fixes it)
//   no-board    — genuinely nothing to read (auth-walled, or not a board)
type Expect = "jobs" | "needs-browser" | "no-board";

const CORPUS: Array<{
  name: string;
  url: string;
  expect: Expect;
  note?: string;
}> = [
  // -- READABLE: verified against the live boards --------------------------
  {
    name: "sitemap + JSON-LD",
    url: "https://jobs.wordpress.net/",
    expect: "jobs",
    note: "WP Job Manager. No API and no state blob — the only way in is the posts sitemap plus each posting's JobPosting markup.",
  },
  {
    name: "RSS feed",
    url: "https://www.canonical.com/careers/all",
    expect: "jobs",
    note: "~300 roles off /careers/feed. The board itself is a client-rendered SPA; the feed is what makes it readable at all.",
  },
  {
    name: "Next.js state blob",
    url: "https://join.com/companies/join",
    expect: "jobs",
    note: "__NEXT_DATA__ → props.pageProps.initialState.jobs.items, with a verified /{id} URL template.",
  },

  // -- NOT READABLE without a browser: the recon / research cases ----------
  // Each is here as a baseline, not a to-do. If one flips to readable the row
  // prints NEWLY READABLE rather than failing — that's a win to fold in, not a
  // regression to chase.
  {
    name: "SPA, no static list",
    url: "https://www.tesla.com/careers/search/",
    expect: "needs-browser",
    note: "Bot-blocked on the plain page fetch, so not even the blob tier gets a look.",
  },
  {
    name: "SPA + sitemap of few",
    url: "https://careers.ibm.com/",
    expect: "needs-browser",
    note: "The sitemap holds category pages, not postings.",
  },
  {
    name: "SPA, own API",
    url: "https://jobs.trivago.com/",
    expect: "needs-browser",
    note: "Board arrives by XHR after render. The prime candidate for scripts/ats/research-board.ts.",
  },
  {
    name: "aggregator SPA",
    url: "https://arc.dev/remote-jobs",
    expect: "needs-browser",
  },

  // -- genuinely nothing to read -------------------------------------------
  {
    name: "ATS root, not a board",
    url: "https://boards.eu.greenhouse.io",
    expect: "no-board",
    note: "A tenant-less ATS host. Must NOT come back readable — a hit here would mean the detector is matching ATS chrome.",
  },
];

async function probeOne(url: string, verbose: boolean) {
  const wired = detectAts(url);
  if (wired) {
    return {
      status: "wired" as const,
      detail: `already handled by the ${wired.provider} provider — not a probe case`,
    };
  }
  const started = Date.now();
  const outcome = await probeGenericBoard(url);
  const ms = Date.now() - started;
  if (!outcome.ok) {
    return {
      status: "miss" as const,
      ms,
      detail: outcome.tried.join(" | "),
    };
  }
  if (verbose) {
    console.log(JSON.stringify(outcome.recipe, null, 2));
    console.log(
      outcome.data.jobs
        .slice(0, 5)
        .map((j) => `  - ${j.title} :: ${j.sourceUrl}`)
        .join("\n"),
    );
  }
  return {
    status: "hit" as const,
    ms,
    jobs: outcome.data.jobs.length,
    technique: outcome.technique,
    family: outcome.recipe.familyKey ?? "-",
  };
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const result = await probeOne(arg, true);
    console.log(`\n${arg}\n  ${JSON.stringify(result)}\n`);
    process.exit(result.status === "hit" ? 0 : 1);
  }

  const rows: string[] = [];
  let hits = 0;
  let regressions = 0;

  for (const entry of CORPUS) {
    const result = await probeOne(entry.url, false);
    const readable = result.status === "hit";
    if (readable) hits++;
    // Only a row that should be readable and isn't counts as a regression.
    // A "needs-browser" row coming back readable is GOOD news — it just means
    // the baseline is stale, so it prints loudly rather than failing.
    const bad = entry.expect === "jobs" && !readable;
    if (bad) regressions++;
    const flag = bad
      ? "REGRESSION"
      : readable && entry.expect !== "jobs"
        ? "NEWLY READABLE"
        : "";
    rows.push(
      [
        entry.name.padEnd(22),
        entry.expect.padEnd(14),
        (readable ? `${result.jobs} jobs` : "miss").padEnd(12),
        (readable ? result.family : "").padEnd(16),
        `${result.status === "wired" ? "-" : `${result.ms}ms`}`.padEnd(8),
        flag,
      ].join(" "),
    );
    if (!readable && result.status === "miss") {
      rows.push(`  tried: ${result.detail}`);
    }
  }

  console.log(
    `\n${"board".padEnd(22)} ${"expect".padEnd(14)} ${"result".padEnd(12)} ${"family".padEnd(16)} ${"time".padEnd(8)}`,
  );
  console.log("-".repeat(90));
  console.log(rows.join("\n"));
  console.log(
    `\n${hits}/${CORPUS.length} readable without an LLM · ${regressions} regression(s)\n`,
  );
  if (regressions > 0) process.exit(1);
}

void main();
