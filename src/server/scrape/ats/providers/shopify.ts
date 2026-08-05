import { currentScrapeSignal } from "../../scrapeSignal";

import type { ScrapeResult, ScrapedJob } from "../../types";
import type { AtsProviderModule } from "../shared";

const SHOPIFY_RE = /^https?:\/\/(?:www\.)?shopify\.com\/careers/i;
// -- Shopify (shopify.com/careers) ----------------------------------------
//
// Single-tenant SPA with no clean endpoint: the search page anti-bot-blocks a
// plain fetch and the detail description lives in a deeply-escaped JS blob. So
// we render with the headless browser — the search page for the job-card list
// (h4 title + .location span + /careers/{slug}_{uuid} href), then each detail
// page's <main> for the body. playwright is lazy-imported so it never loads for
// the plain-fetch providers; a missing Chromium degrades to an error envelope.
//
// Questions: apply is login-gated → unsupported.
const SHOPIFY_MAX_JOBS = 30;
const SHOPIFY_DETAIL_CONCURRENCY = 4;

type ShopifyCard = { href: string; title: string; location: string };

async function fetchShopifyDetail(
  ctx: import("playwright").BrowserContext,
  card: ShopifyCard,
): Promise<ScrapedJob | null> {
  if (!card.title) return null;
  const page = await ctx.newPage();
  try {
    await page.goto(card.href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForSelector("main", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
    // The rendered <main> holds the full posting; strip the leading "Back …
    // Apply Now" chrome by cutting to the first real section heading when present.
    const body = await page
      .$eval("main", (el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .catch(() => "");
    if (body.length < 200) return null;
    const cut = body.search(/About the (role|team)|Responsibilities|What you/i);
    const desc = cut > 0 ? body.slice(cut) : body;
    const parts: string[] = [card.title];
    if (card.location) parts.push(card.location);
    parts.push("");
    parts.push(desc);
    return {
      title: card.title,
      sourceUrl: card.href,
      rawContent: parts.join("\n").trim(),
      location: card.location || undefined,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchAllShopify(): Promise<ScrapeResult> {
  let headless: typeof import("@/server/platform/browser/headless");
  try {
    headless = await import("@/server/platform/browser/headless");
  } catch (err) {
    return {
      ok: false,
      error: `shopify: headless module unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return await headless.withHeadlessContext(
      async (ctx) => {
        const list = await ctx.newPage();
        await list.goto("https://www.shopify.com/careers/search", {
          waitUntil: "domcontentloaded",
        });
        await list
          .waitForSelector("a[href*='/careers/']", { timeout: 20_000 })
          .catch(() => {});
        // Load more results (the list lazy-loads on scroll).
        for (let i = 0; i < 6; i += 1) {
          await list.mouse.wheel(0, 5000);
          await list.waitForTimeout(700);
        }
        const cards = (await list.$$eval("a[href*='/careers/']", (anchors) => {
          const out: Array<{ href: string; title: string; location: string }> =
            [];
          const seen = new Set<string>();
          for (const a of anchors) {
            const href = (a as HTMLAnchorElement).href;
            if (
              !/\/careers\/[a-z0-9-]+_[a-f0-9-]{8,}/i.test(href) ||
              seen.has(href)
            )
              continue;
            seen.add(href);
            const h = a.querySelector("h1,h2,h3,h4,h5");
            const loc = a.querySelector(
              ".location span, [class*=location] span, .location",
            );
            out.push({
              href,
              title: (h?.textContent || "").trim(),
              location: (loc?.textContent || "").trim(),
            });
          }
          return out;
        })) as ShopifyCard[];

        const capped = cards.slice(0, SHOPIFY_MAX_JOBS);
        const jobs: ScrapedJob[] = [];
        for (let i = 0; i < capped.length; i += SHOPIFY_DETAIL_CONCURRENCY) {
          const chunk = capped.slice(i, i + SHOPIFY_DETAIL_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((c) => fetchShopifyDetail(ctx, c)),
          );
          for (const s of settled)
            if (s.status === "fulfilled" && s.value) jobs.push(s.value);
        }
        return {
          ok: true as const,
          data: {
            companyName: "Shopify",
            jobs,
            diagnostics: {
              provider: "shopify" as const,
              fetchedUrl: "https://www.shopify.com/careers/search",
              pageLength: cards.length,
              pageSnippet: capped
                .slice(0, 5)
                .map((c) => c.title)
                .join(" | "),
              ...(cards.length > SHOPIFY_MAX_JOBS
                ? { truncatedAt: jobs.length }
                : {}),
            },
          },
        };
      },
      { timeoutMs: 35_000, signal: currentScrapeSignal() },
    );
  } catch (err) {
    if (err instanceof headless.HeadlessUnavailableError) {
      return {
        ok: false,
        error: `shopify: headless browser unavailable — deploy needs \`playwright install chromium\` (${err.message})`,
      };
    }
    return {
      ok: false,
      error: `shopify: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const shopify: AtsProviderModule = {
  provider: "shopify",
  hostFragments: [],
  // Apply is login-gated → questions unsupported.
  supportsQuestions: false,
  detect(url) {
    if (!SHOPIFY_RE.test(url)) return null;
    return {
      provider: "shopify",
      fetchedUrl: "https://www.shopify.com/careers/search",
      fetchAll: () => fetchAllShopify(),
    };
  },
};
