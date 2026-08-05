import { currentScrapeSignal } from "../../scrapeSignal";

import type { ScrapeResult, ScrapedJob } from "../../types";
import type { AtsProviderModule } from "../shared";

const NETFLIX_RE = /^https?:\/\/jobs\.netflix\.com\//i;
// -- Netflix (jobs.netflix.com) -------------------------------------------
//
// Next.js App Router; jobs arrive as RSC flight payloads (no JSON API) and the
// /search DOM surfaces mostly category links. We render /search, scroll to load
// jobs, collect /jobs/{id} anchors, then render each detail for its body. If the
// list comes back empty (RSC didn't yield job anchors) the scrape returns 0 jobs
// — Netflix is the most fragile of the set. Questions: login-gated.
const NETFLIX_MAX_JOBS = 25;
const NETFLIX_DETAIL_CONCURRENCY = 4;

async function fetchNetflixDetail(
  ctx: import("playwright").BrowserContext,
  href: string,
): Promise<ScrapedJob | null> {
  const page = await ctx.newPage();
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page
      .waitForSelector("main, [class*=job], h1", { timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
    const data = await page
      .evaluate(() => {
        const h = document.querySelector("h1, h2");
        const main =
          document.querySelector("main, [class*=description], article") ||
          document.body;
        return {
          title: (h?.textContent || document.title).trim(),
          text: (main?.textContent || "").replace(/\s+/g, " ").trim(),
        };
      })
      .catch(() => null);
    if (!data?.title || data.text.length < 200) return null;
    const title = data.title.replace(/\s*[—–|]\s*Netflix.*$/i, "").trim();
    return {
      title,
      sourceUrl: href.split("?")[0],
      rawContent: `${title}\n\n${data.text}`.trim(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchAllNetflix(): Promise<ScrapeResult> {
  let headless: typeof import("@/server/platform/browser/headless");
  try {
    headless = await import("@/server/platform/browser/headless");
  } catch (err) {
    return {
      ok: false,
      error: `netflix: headless module unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return await headless.withHeadlessContext(
      async (ctx) => {
        const list = await ctx.newPage();
        await list.goto("https://jobs.netflix.com/search", {
          waitUntil: "domcontentloaded",
        });
        await list.waitForTimeout(4000);
        for (let i = 0; i < 5; i += 1) {
          await list.mouse.wheel(0, 4000);
          await list.waitForTimeout(900);
        }
        const hrefs = await list.$$eval("a", (as) =>
          Array.from(
            new Set(
              as
                .map((a) => a.href)
                .filter((h) => /jobs\.netflix\.com\/jobs\/\d/.test(h)),
            ),
          ),
        );
        const capped = hrefs.slice(0, NETFLIX_MAX_JOBS);
        const jobs: ScrapedJob[] = [];
        for (let i = 0; i < capped.length; i += NETFLIX_DETAIL_CONCURRENCY) {
          const chunk = capped.slice(i, i + NETFLIX_DETAIL_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((h) => fetchNetflixDetail(ctx, h)),
          );
          for (const s of settled)
            if (s.status === "fulfilled" && s.value) jobs.push(s.value);
        }
        if (jobs.length === 0) {
          // Netflix's /search surfaces only category links in the DOM and serves
          // jobs as RSC flight payloads that don't carry the listing — no job
          // anchors are reachable. Honest failure beats a misleading "0 jobs".
          return {
            ok: false as const,
            error:
              "netflix: no job postings reachable — jobs.netflix.com renders category links only and serves listings via RSC with no extractable job URLs.",
          };
        }
        return {
          ok: true as const,
          data: {
            companyName: "Netflix",
            jobs,
            diagnostics: {
              provider: "netflix" as const,
              fetchedUrl: "https://jobs.netflix.com/search",
              pageLength: hrefs.length,
              pageSnippet: capped.slice(0, 3).join(" | "),
              ...(hrefs.length >= NETFLIX_MAX_JOBS
                ? { truncatedAt: jobs.length }
                : {}),
            },
          },
        };
      },
      { timeoutMs: 45_000, signal: currentScrapeSignal() },
    );
  } catch (err) {
    if (err instanceof headless.HeadlessUnavailableError) {
      return {
        ok: false,
        error: `netflix: headless browser unavailable — deploy needs \`playwright install chromium\` (${err.message})`,
      };
    }
    return {
      ok: false,
      error: `netflix: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const netflix: AtsProviderModule = {
  provider: "netflix",
  hostFragments: [],
  // Apply is login-gated → questions unsupported.
  supportsQuestions: false,
  detect(url) {
    if (!NETFLIX_RE.test(url)) return null;
    return {
      provider: "netflix",
      fetchedUrl: "https://jobs.netflix.com/search",
      fetchAll: () => fetchAllNetflix(),
    };
  },
};
