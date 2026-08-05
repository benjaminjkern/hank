import { currentScrapeSignal } from "../../scrapeSignal";
import { rawAttrs, type AtsProviderModule } from "../shared";

import type { ScrapeResult, ScrapedJob } from "../../types";

const META_RE = /^https?:\/\/(?:www\.)?metacareers\.com\//i;
// -- Meta (metacareers.com) — list-only -----------------------------------
//
// The SPA fetches its list from a GraphQL query (CareersJobSearchResultsV2DataQuery
// → job_search_with_featured_jobs_v2.all_jobs: id/title/locations/teams). We
// render the jobs page and capture that response. The DETAIL/description is
// genuinely unreachable — the job page renders only obfuscated bootstrap JS (no
// DOM description) and the detail GraphQL never fires capturably — so Meta is
// LIST-ONLY: rawContent is title + locations + teams. Questions: login-gated.
async function fetchAllMeta(): Promise<ScrapeResult> {
  let headless: typeof import("@/server/platform/browser/headless");
  try {
    headless = await import("@/server/platform/browser/headless");
  } catch (err) {
    return {
      ok: false,
      error: `meta: headless module unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return await headless.withHeadlessContext(
      async (ctx) => {
        const collected: Array<{
          id?: string;
          title?: string;
          locations?: string[];
          teams?: string[];
          sub_teams?: string[];
        }> = [];
        ctx.on("response", async (r) => {
          if (!r.url().includes("/graphql")) return;
          let t = "";
          try {
            t = await r.text();
          } catch {
            return;
          }
          if (!t.includes("all_jobs")) return;
          try {
            const j = JSON.parse(t.split("\n")[0]) as {
              data?: {
                job_search_with_featured_jobs_v2?: {
                  all_jobs?: typeof collected;
                };
              };
            };
            const aj = j?.data?.job_search_with_featured_jobs_v2?.all_jobs;
            if (Array.isArray(aj)) collected.push(...aj);
          } catch {
            /* ignore non-JSON */
          }
        });
        const page = await ctx.newPage();
        await page.goto("https://www.metacareers.com/jobs", {
          waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(6000);
        const seen = new Set<string>();
        const jobs: ScrapedJob[] = [];
        for (const j of collected) {
          const id = String(j.id ?? "");
          const title = (j.title ?? "").trim();
          if (!id || !title || seen.has(id)) continue;
          seen.add(id);
          const location = Array.isArray(j.locations)
            ? j.locations.join(" • ")
            : undefined;
          const teams = Array.isArray(j.teams) ? j.teams.join(", ") : undefined;
          const parts: string[] = [title];
          const meta = [location, teams].filter(Boolean).join(" • ");
          if (meta) parts.push(meta);
          jobs.push({
            title,
            sourceUrl: `https://www.metacareers.com/jobs/${id}/`,
            rawContent: parts.join("\n").trim(),
            location,
            department: Array.isArray(j.teams) ? j.teams[0] : undefined,
            attributes: rawAttrs(j),
          });
        }
        return {
          ok: true as const,
          data: {
            companyName: "Meta",
            jobs,
            diagnostics: {
              provider: "meta" as const,
              fetchedUrl: "https://www.metacareers.com/jobs",
              pageLength: collected.length,
              // List-only: Meta's per-job description is login/JS-gated.
              pageSnippet: "meta list-only (no per-job description available)",
            },
          },
        };
      },
      { timeoutMs: 30_000, signal: currentScrapeSignal() },
    );
  } catch (err) {
    if (err instanceof headless.HeadlessUnavailableError) {
      return {
        ok: false,
        error: `meta: headless browser unavailable — deploy needs \`playwright install chromium\` (${err.message})`,
      };
    }
    return {
      ok: false,
      error: `meta: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const meta: AtsProviderModule = {
  provider: "meta",
  hostFragments: [],
  // Apply is login-gated → questions unsupported.
  supportsQuestions: false,
  detect(url) {
    if (!META_RE.test(url)) return null;
    return {
      provider: "meta",
      fetchedUrl: "https://www.metacareers.com/jobs",
      fetchAll: () => fetchAllMeta(),
    };
  },
};
