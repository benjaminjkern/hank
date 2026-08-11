// Use a real browser to work out how to read a board WITHOUT one.
//
// This is the only sanctioned use of headless Chromium in this codebase's
// scraping story, and it is deliberately not a scraping tier. Prod can't launch
// a browser; a local machine can. So we render the board once, watch which JSON
// the page fetches for itself, and emit a recipe that calls that endpoint
// directly — which prod then runs with no browser at all.
//
// A board that needed a browser forever would be a permanent hole. A board
// whose endpoint we discovered once is just another recipe.
//
// Requires HEADLESS_BROWSER=local in .env and `pnpm exec playwright install
// chromium`. Writes nothing — it prints a recipe for you to paste into the
// BoardReader row (or into a new provider file, if the family is common enough
// to deserve one).
//
//   pnpm ats:research-board https://jobs.trivago.com/

import "dotenv/config";

import { findJobArray } from "../../src/server/scrape/generic/jobShape";
import {
  buildRecipe,
  planSourceUrl,
  withPageDetail,
} from "../../src/server/scrape/generic/fieldMap";
import {
  browserCapability,
  withBrowser,
} from "../../src/server/platform/browser/browserCapability";
import { closeHeadless } from "../../src/server/platform/browser/headless";
import { runBoardRecipe } from "../../src/server/scrape/recipe/runRecipe";

import type { BoardRecipe } from "../../src/server/scrape/recipe/types";

const SETTLE_MS = 5_000;
const SCROLL_ROUNDS = 4;
const MAX_CAPTURED = 40;

type Captured = {
  url: string;
  method: string;
  body: string | null;
  payload: unknown;
};

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: pnpm ats:research-board <board-url>");
    process.exit(1);
  }
  if (browserCapability() === "none") {
    console.error(
      "No browser available. Set HEADLESS_BROWSER=local in .env and run `pnpm exec playwright install chromium`.",
    );
    process.exit(1);
  }

  console.log(`\nrendering ${url} …`);
  const captured = await capture(url);
  console.log(
    `captured ${captured.length} JSON response(s) with job-shaped data\n`,
  );

  if (captured.length === 0) {
    console.log(
      "Nothing job-shaped came back over XHR. The board may render its list server-side\n" +
        "(try the plain probe: pnpm ats:probe-corpus <url>), or it may paginate behind a\n" +
        "signed request this can't replay.\n",
    );
    return;
  }

  for (const hit of captured) {
    console.log(`--- ${hit.method} ${hit.url}`);
    const match = findJobArray(hit.payload);
    if (!match) {
      console.log("    (no job array found in this payload)\n");
      continue;
    }
    // A captured POST is only replayable if its body is fixed. One that carries
    // a page cursor or a signature will work once and then quietly stop, which
    // is worse than not offering it.
    if (hit.method === "POST" && hit.body && looksVolatile(hit.body)) {
      console.log(
        `    POST body looks request-specific (${hit.body.slice(0, 80)}…) — not replayable as a recipe\n`,
      );
      continue;
    }

    const plan = planSourceUrl(match, url);
    if (plan.kind === "none") {
      console.log("    no usable posting URL in the payload\n");
      continue;
    }
    if (plan.kind === "template") {
      console.log(
        `    NOTE: posting URLs are built from a template — verify: ${plan.samples.join(", ")}`,
      );
    }

    let recipe: BoardRecipe = buildRecipe({
      list: {
        kind: "json",
        url: hit.url,
        ...(hit.method === "POST"
          ? { method: "POST" as const, ...(hit.body ? { body: hit.body } : {}) }
          : {}),
      },
      itemsPath: match.path,
      match,
      sourceUrl: plan.spec,
      familyKey: "xhr-capture",
    });
    if (!recipe.fields.rawContent) recipe = withPageDetail(recipe);

    // The whole point: prove it works with the browser closed.
    const verified = await runBoardRecipe(recipe, { boardUrl: url });
    if (!verified.ok) {
      console.log(`    FAIL browserless: ${verified.error}\n`);
      continue;
    }
    console.log(
      `    PASS browserless — ${verified.data.jobs.length} postings, e.g. "${verified.data.jobs[0]?.title}"`,
    );
    console.log(JSON.stringify(recipe, null, 2));
    console.log("");
  }
}

async function capture(url: string): Promise<Captured[]> {
  const hits: Captured[] = [];
  await withBrowser(
    "board research",
    async (ctx) => {
      const page = await ctx.newPage();
      page.on("response", (res) => {
        if (hits.length >= MAX_CAPTURED) return;
        const type = res.headers()["content-type"] ?? "";
        if (!type.includes("json")) return;
        void res
          .text()
          .then((text) => {
            let payload: unknown;
            try {
              payload = JSON.parse(text);
            } catch {
              return;
            }
            // Reuse the SAME detector the deterministic probe uses, so a
            // captured endpoint is judged by exactly the bar a recipe has to
            // clear later.
            if (!findJobArray(payload)) return;
            const req = res.request();
            hits.push({
              url: res.url(),
              method: req.method(),
              body: req.postData(),
              payload,
            });
          })
          .catch(() => {
            /* body already consumed or the response was aborted */
          });
      });

      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(SETTLE_MS);
      // Scroll to trigger the paging XHR — the request pattern is what we're
      // actually after, and plenty of boards only fire it on demand.
      for (let i = 0; i < SCROLL_ROUNDS; i++) {
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(1200);
      }
      await page.close();
    },
    { timeoutMs: 45_000 },
  );
  // Dedupe on URL — a scrolled board re-fetches the same endpoint per page.
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.method} ${h.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksVolatile(body: string): boolean {
  return /"(offset|page|cursor|after|token|signature|timestamp)"\s*:/i.test(
    body,
  );
}

void main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  // The Chromium singleton keeps the event loop alive; without this the script
  // hangs after printing.
  .finally(() => closeHeadless());
