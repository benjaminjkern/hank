import { currentScrapeSignal } from "../../scrapeSignal";

import type { ScrapeResult, ScrapedJob } from "../../types";
import type { AtsProviderModule } from "../shared";

const GOOGLE_RE =
  /^https?:\/\/(?:www\.)?google\.com\/about\/careers\/applications/i;
// -- Google (google.com/about/careers/applications) -----------------------
//
// Single-tenant SPA backed by a batchexecute RPC (no plain JSON), but the
// rendered results page exposes clean /jobs/results/{id}-{slug} cards and each
// detail page renders the full posting in <main>. So: render the results pages
// for the URL list (paged via &page=N), then render each detail and pull
// <main> text + the page title + a best-effort location parse. Apply is
// Google-account-gated → questions unsupported.
const GOOGLE_MAX_JOBS = 25;
const GOOGLE_DETAIL_CONCURRENCY = 4;

async function fetchGoogleDetail(
  ctx: import("playwright").BrowserContext,
  href: string,
): Promise<ScrapedJob | null> {
  const page = await ctx.newPage();
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("main", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(700);
    const data = await page
      .evaluate(() => ({
        title: document.title,
        text: (document.querySelector("main")?.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
      }))
      .catch(() => null);
    if (!data || data.text.length < 200) return null;
    const title =
      data.title.replace(/\s*[—–|-]\s*Google.*$/i, "").trim() || "Role";
    // Location renders after a Material "place" icon glyph; grab up to the next
    // section/icon word.
    const locM = data.text.match(
      /place\s*([A-Z][^]*?)(?:bookmark_border|bookmark|corporate_fare|Apply|Minimum qualifications|About the job|Learn|info_outline|Note:|share)/,
    );
    const location = locM
      ? locM[1].replace(/\s+/g, " ").trim().slice(0, 100)
      : undefined;
    const cut = data.text.search(
      /Minimum qualifications|About the job|Responsibilities|Preferred qualifications/i,
    );
    const desc = cut > 0 ? data.text.slice(cut) : data.text;
    const parts: string[] = [title];
    if (location) parts.push(location);
    parts.push("");
    parts.push(desc);
    return {
      title,
      sourceUrl: href.split("?")[0],
      rawContent: parts.join("\n").trim(),
      location,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchAllGoogle(inputUrl: string): Promise<ScrapeResult> {
  let headless: typeof import("@/server/platform/browser/headless");
  try {
    headless = await import("@/server/platform/browser/headless");
  } catch (err) {
    return {
      ok: false,
      error: `google: headless module unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let query = "q=software+engineer";
  try {
    const u = new URL(inputUrl);
    u.searchParams.delete("page");
    if (u.searchParams.toString()) query = u.searchParams.toString();
  } catch {
    /* default query */
  }
  try {
    return await headless.withHeadlessContext(
      async (ctx) => {
        const list = await ctx.newPage();
        const hrefs = new Set<string>();
        for (let pg = 1; pg <= 3 && hrefs.size < GOOGLE_MAX_JOBS; pg += 1) {
          await list.goto(
            `https://www.google.com/about/careers/applications/jobs/results?${query}&page=${pg}`,
            { waitUntil: "domcontentloaded" },
          );
          await list
            .waitForSelector("a[href*='/jobs/results/']", { timeout: 15_000 })
            .catch(() => {});
          await list.waitForTimeout(1500);
          const batch = await list.$$eval("a[href*='/jobs/results/']", (as) =>
            (as as HTMLAnchorElement[])
              .map((a) => a.href)
              .filter((h) => /\/jobs\/results\/\d+/.test(h)),
          );
          const before = hrefs.size;
          for (const h of batch) hrefs.add(h.split("?")[0]);
          if (hrefs.size === before) break; // no new results → last page
        }
        const capped = Array.from(hrefs).slice(0, GOOGLE_MAX_JOBS);
        const jobs: ScrapedJob[] = [];
        for (let i = 0; i < capped.length; i += GOOGLE_DETAIL_CONCURRENCY) {
          const chunk = capped.slice(i, i + GOOGLE_DETAIL_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((h) => fetchGoogleDetail(ctx, h)),
          );
          for (const s of settled)
            if (s.status === "fulfilled" && s.value) jobs.push(s.value);
        }
        if (jobs.length === 0) {
          // Google careers' rendered results are bot-detection-flaky in headless —
          // sometimes the cards render, sometimes the page stays empty. Surface an
          // honest failure rather than a misleading "0 jobs".
          return {
            ok: false as const,
            error:
              "google: headless render returned no job cards (Google careers bot-detection / SPA timing). Retry, or supply a specific job URL.",
          };
        }
        return {
          ok: true as const,
          data: {
            companyName: "Google",
            jobs,
            diagnostics: {
              provider: "google" as const,
              fetchedUrl:
                "https://www.google.com/about/careers/applications/jobs/results",
              pageLength: capped.length,
              pageSnippet: capped.slice(0, 3).join(" | "),
              ...(hrefs.size >= GOOGLE_MAX_JOBS
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
        error: `google: headless browser unavailable — deploy needs \`playwright install chromium\` (${err.message})`,
      };
    }
    return {
      ok: false,
      error: `google: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const google: AtsProviderModule = {
  provider: "google",
  hostFragments: [],
  // Apply is Google-account-gated → questions unsupported.
  supportsQuestions: false,
  detect(url) {
    if (!GOOGLE_RE.test(url)) return null;
    return {
      provider: "google",
      fetchedUrl:
        "https://www.google.com/about/careers/applications/jobs/results",
      fetchAll: () => fetchAllGoogle(url),
    };
  },
};
