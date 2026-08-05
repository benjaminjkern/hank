import { z } from "zod";

import { fetchCleanedUrl } from "@/server/scrape/fetchCleanedUrl";
import { withScrapeSignal } from "@/server/scrape/scrapeSignal";
import { normalizeUrlInput } from "@/utils/url";

import { toolError } from "../lib/toolError";

import type { ToolDef } from "../lib/types";

export const fetchUrlTool: ToolDef<{ url: string }> = {
  name: "fetch_url",
  description:
    "Fetch a specific URL (e.g. a single job posting the user pasted into chat) and return its cleaned text (HTML stripped). Use for one-off pages outside the watchlist. Don't use for the watchlist scan — that's scrape_jobs_for_company. SPA pages return little useful content. The result is capped at ~8000 chars — if you need more, ask the user to point you at a more specific URL.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute URL to fetch." },
    },
    required: ["url"],
  },
  parser: z.object({
    url: z.string().transform(normalizeUrlInput).pipe(z.url()),
  }),
  async handle({ url }, ctx) {
    // The fetch + HTML-clean + cap lives in scrape/fetchCleanedUrl; the tool only
    // shapes the toolError + its observability dedupKey from the host.
    const result = await withScrapeSignal(ctx.signal, () =>
      fetchCleanedUrl(url),
    );
    ctx.signal?.throwIfAborted();
    if (result.ok) return { content: result.text };
    if (result.kind === "non_200") {
      return toolError(
        "UPSTREAM_FETCH_FAILED",
        `fetch ${url}: ${result.status} ${result.statusText}`,
        `fetch_url:fetch_non_200:${result.host}`,
      );
    }
    return toolError(
      "UPSTREAM_FETCH_FAILED",
      `fetch ${url}: ${result.message}`,
      `fetch_url:fetch_threw:${result.host}`,
    );
  },
};
